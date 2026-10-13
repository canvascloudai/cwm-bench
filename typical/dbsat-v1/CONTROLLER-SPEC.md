# typical-dbsat-v1 controller 1.1.0 specification (runner-side)

The campaign controller is **not in this repo**. p95-v1 ran on the runner's controller 1.0.3 (SHA256 `374e8eba…c848`, recorded in the p95-v1 raw archive `verification/`). This document is the contract that controller 1.1.0 must implement for `typical-dbsat-v1`. Rule numbers refer to `PREREGISTRATION.md`. Where this spec and the prereg differ, the prereg wins.

The controller's SHA256 is recorded in the campaign evidence and is part of the frozen package: a controller change mid-campaign means `typical-dbsat-v1.1` (§7.7).

## 0. What the adapter (1.7.0, this repo) already provides

| Need | Adapter surface |
| --- | --- |
| Keys | `typical-dbsat-{2x,3x,4x}-{300,500,700,900,1100,1300,1500}`, us-east-2, `app_count` 2/3/4 (`APP_COUNT_MISMATCH`) |
| Test ids | `typical-dbsat-{2x\|3x\|4x}-{r1\|r2\|c1\|d1}[letter]-YYYYMMDD`: r = discovery rep, c1 = confirmation, d1 = dry run; a letter marks a replacement |
| Ladder | ascending prefix of `300,500,…,1500` enforced per test id (`LADDER_ORDER`); confirmation is the same prefix, stopped at S_next (§7.4) |
| Generators | `generator_count` 1 or 2 (Terraform). With 2, `run` starts k6 on both with `K6_SEGMENT` `0:1/2` and `1/2:1`; each generator offers half the rate |
| VUs | `preAllocatedVUs = ceil(RPS × CWM_VU_PRE_S)`, `maxVUs = ceil(RPS × CWM_VU_MAX_S)`; defaults 0.5 s / 2.5 s; frozen after the dry run |
| Breach stop | `teardown` with `CWM_STOP_REASON=breach` (and `CWM_STOPPED_AT`) writes `stopped.json`, SIGINTs k6 so `summary.json` and `k6.json.gz` are still written, on every generator. The concurrent `run` then returns `ok: true`, `stepStatus: "overload observation"`, `partialStep` |
| Collect | `dbsat.steadyP95` (nearest rank from `k6.json.gz`, phase=steady; merged log histogram with 2 generators), `perMinute` P95 / requests / failures, `droppedIterations`; `dbsat.performanceInsights` (`db.load.avg`, and by `db.wait_event_type`, 60 s); `dbsat.poolMetrics` (per app node `/api/metrics`, clipped to the window); `dbsat.cloudwatch` (CPU and NetworkOut on every generator, ALB TargetConnectionErrorCount); `dbsat.partialStep`. Missing evidence appears in `missing` with `complete: false` |
| Measurement SHA | `CWM_MEASUREMENT_SHA` vs each app node `/api/meta` gitSha (`MEASUREMENT_SHA_MISMATCH`) |

## 1. Per-minute breach evaluation (§7.1)

- Start evaluating at the first full minute of the steady phase (warmup start + 5 min). Warmup minutes are recorded, never counted.
- Each minute, read the generator's live k6 output for the closing minute: error rate = failed / requests from `http_req_failed` points, P95 = nearest rank of that minute's `http_req_duration` points. With 2 generators, sum requests and failures; take P95 from the merged samples (or the merged log histogram).
  - Source: tail `k6.json` on each generator over SSM (the adapter's `steady_p95.py` logic, applied to one minute), or an equivalent k6 output stream. A minute with no data counts as **not over the limit** and is logged as a data gap.
- A minute is over the limit if error rate **> 5%** or P95 **> 2,000 ms**.
- **Breach** = 3 consecutive over-limit minutes. At the end of the third minute: run `node scripts/worker-adapter.mjs teardown --json` with `CWM_STOP_REASON=breach`, `CWM_STOPPED_AT=<ISO>`, and the run's `CWM_CAMPAIGN_ID` / `CWM_RUN_ID`. Wait for the `run` call to return `stepStatus: "overload observation"`, then `collect` as usual (set `CWM_RUN_ENDED_AT` to the stop time).
- After a breach: **no higher step on that apply** (the sweep stops). Record the step as "overload, N min" with N = complete steady minutes.
- Log every minute's (error rate, P95, requests, over-limit flag) to `out/breach-<KEY>.jsonl`.

## 2. Recovery protocol (§7.2)

Needed only if further load is planned on the stack: that is, in confirmation when steps remain, and for evidence after a discovery breach.

1. **Idle baseline at wait-ready** (before the first step): record DB CPU, DatabaseConnections and PI AAS (3-minute means) to `out/04-idle-baseline.json`.
2. **Pre-ladder probe**: right after wait-ready, a 3-minute 100 RPS probe with the `typical.js` mix, started by the controller over SSM on the primary generator (`k6 run -e SCENARIO=typical-p95-2x-100 -e WARMUP=0s -e DURATION=3m … load/typical.js`, run id `<APPLY>-probe0`, own results directory). It is not an adapter key, so it never enters the ladder history; it is not a step and not scored. Record its P95 and error rate as `out/05-probe-baseline.json`.
3. After a breach stop, poll every minute for up to **15 minutes**. Success needs **3 consecutive minutes** with DB CPU < 30%, DatabaseConnections ≤ max(baseline × 1.2, baseline + 20), and PI AAS < 0.5.
4. Then a 3-minute 100 RPS probe: steady P95 ≤ 1.5 × the pre-ladder probe P95 and error rate < 0.1%. One probe retry is allowed inside the same 15-minute window.
5. If not met: **abort** the apply, destroy, mark it `recovery failed`. This is **valid overload evidence**. It never authorizes a replacement, and completed comparisons are kept (§7.2, §7.4, §7.7).
6. Write `out/recovery-<KEY>.json` with every poll, both probes, and the verdict.

## 3. Confirmation mode (§7.4)

- Input: the candidate transitions from `score_dbsat_v1.py` on the discovery reps (`outcome == "candidate DB breakpoint"`, with `s_prev`, `s_star`). The controller never decides a candidate on its own.
- Server counts to run: those in the triggered transitions. **Fixed order 2× → 3× → 4×, back to back on one UTC day.** If both 2→3 and 3→4 have candidates, a **single shared 3×** apply runs to the higher of the two S_next values and is used in both pairs.
- Each apply (`typical-dbsat-${N}x-c1-YYYYMMDD`) runs the **full ascending conditioning ladder** from 300 to S_next: the step above S\*, or S\* itself when S\* = 1500 or S_next was breached / not tested in discovery. Pass that prefix as `CWM_LADDER` (for example `300,500,700,900,1100,1300`). Steps below S_prev are conditioning only.
- Breach and recovery apply unchanged. A workload-triggered breach or recovery failure is a **valid result**. If it prevents a step that (a)–(d) needs, the scorer reports "confirmation not completed due to overload". No replacement.
- **Invalid confirmation** (collection failure, a generator-invalid step per §7.5, data still missing after re-collects, an infra/harness error) follows the replacement rules: letter suffix (`c1a`), counted against the 6-replacement cap.
- A failed confirmation is final. Never retry it.

## 4. Spend guard (§7.7, §11)

- Conservative upper-bound basis, frozen in the evidence (not the bill). Per stack-hour: 2× 0.68, 3× 0.77, 4× 0.87 USD with one generator; add **0.17** per extra generator (c6i.xlarge). Count from `terraform apply` start to destroy confirmation, rounded up to the next 15 minutes, plus RDS storage at 0.014/h.
- Before every apply and every step, project spend = spent so far + the remaining time of the current apply + the full next apply (3.25 h).
- **At a projected $60, or when a 7th replacement would be needed: pause and ask Kevin. Never auto-stop**, and never skip or shorten steps to save money. Kevin decides whether a live stack stays up while paused.
- Log the guard state to `out/spend-guard.json` on every update.

## 5. Generator decision (dry run, §7.5)

- Dry run: one apply `typical-dbsat-4x-d1-YYYYMMDD`, `generator_count=1`, full ladder, unscored, **before** `measurement_sha` is fixed.
- Generator-invalid if dropped iterations > 0.5% of RPS × 1,050, generator CPU steady mean > 70%, or NetworkOut mean ≥ 70% of 1.5625 Gbit/s. Diagnose in order: VU allocation (`CWM_VU_PRE_S` / `CWM_VU_MAX_S`), generator CPU, network / ephemeral ports.
- If invalid steps remain after the VU fix, use `generator_count=2` for the **whole campaign**. Commit the decision and the VU values with the dry-run evidence. Both are frozen from then on.

## 6. IAM for the runner identity (in addition to p95-v1)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "PerformanceInsightsRead", "Effect": "Allow",
      "Action": ["pi:GetResourceMetrics", "pi:DescribeDimensionKeys", "pi:ListAvailableResourceMetrics"],
      "Resource": "arn:aws:pi:us-east-2:<ACCOUNT>:metrics/rds/*" },
    { "Sid": "RdsDescribe", "Effect": "Allow",
      "Action": ["rds:DescribeDBInstances"], "Resource": "*" }
  ]
}
```

Terraform needs nothing new for PI beyond the existing `rds:CreateDBInstance` / `rds:ModifyDBInstance` rights (PI with 7-day retention uses the AWS-managed key). The second generator reuses the existing EC2 instance profile and security group.

## 7. Required artifacts per apply (in addition to p95-v1's `out/` layout)

`04-idle-baseline.json`, `05-probe-baseline.json`, `breach-<KEY>.jsonl` for every step, `recovery-<KEY>.json` after any breach, `spend-guard.json`, the controller SHA256, `generator_count`, and the VU settings.
