# cwm-bench `typical-scale-v1`: app-server count change (1× / 2× / 3× m5.large), pre-registration

Status: **FINAL.** Predictions are frozen against engine **1.2.14** at **2026-10-06 12:41:17 EDT** (`America/New_York`). Nothing has been applied on AWS. The campaign `measurement_sha` is the commit that contains this file, `typical/scale-v1/predictions/`, and the adapter 1.5.0 wiring. That SHA is `app_source_git_ref` for every apply. After that commit, any change to §2–§8 is a new campaign version (`typical-scale-v2`). This mirrors `typical/PREREGISTRATION.md` §11.

Written 2026-10-06. Owner: Kevin Brown. Finalized from the 2026-10-06 draft against `canvascloudai/cwm-bench` `main` (PR #15 merge `64c6e89d…` plus the holdout write-up).

Labels (same as `typical/PREREGISTRATION.md`):
- **[FACT]**: in the repo or in a committed artifact, cited inline.
- **[DECISION]**: a choice for this campaign. Items still open are in §12, each with a recommended default.
- **[ASSUMPTION]**: unverified premise.
- **[DERIVED]**: arithmetic from facts above it, with the arithmetic shown.

---

## 0. One-paragraph summary

Measure the frozen typical-v1 workload on 1, 2 and 3 × m5.large app servers at 100, 200 and 300 total RPS. Everything else stays fixed: DB, region, mix, workers, per-node pool. Run 3 independent repetitions per configuration: **9 separate applies, 27 rungs**, with the ladder 100 → 200 → 300 on every apply. Before any apply, freeze CWM's predictions for all 9 config × rung cells. Score (a) absolute accuracy per rung, page-style, and (b) **delta accuracy**: the predicted vs measured change relative to the 2× baseline in CPU, P95, goodput and errors, with direction and magnitude criteria derived from the run-to-run spread already observed in `typical-holdouts-v1-20261006`. This is validation data only. No coefficient, calibration-id or engine change comes from this campaign. The live 2 → 1 → 2 failure/recovery test is out of scope (§11).

Decision D1 is **closed: ship the owned-scaled model first.** That path is engine **1.2.14**, already shipped before this freeze. The 2× cells are `calibrationEvidence.kind = "owned"`. The 1× and 3× cells are `owned-scaled` (scaled from the typical-v1 two-server fit; those server counts were not measured). An earlier unfrozen check on engine 1.2.13 returned generic `modeled` for 1× and 3× (§5.5). That check is not scored. Scoring uses only the frozen 1.2.14 files in `typical/scale-v1/predictions/`.

---

## 1. Purpose and questions

Q1. **Baseline reproduction.** Does 2 × m5.large reproduce the existing typical measurements at 100 / 200 / 300 RPS?
Q2. **Absolute accuracy.** For every config × rung, how close are CWM's frozen predictions, using the page's per-metric scoring?
Q3. **Delta accuracy (primary).** For 2→1 and 2→3, does CWM predict the **direction** and **rough size** of the change in app CPU, P95, goodput and error rate?
Q4. **Diminishing returns.** Is the latency gain from 2→3 smaller than the gain from 1→2, with DB-side metrics flat (a DB-limited regime)? Does CWM rank it the same way?
Q5. **Connection limits.** What happens to DB connections and connection-class errors when per-node pools are held at 250 (1× = 250 potential sessions, 3× = 750 against `max_connections` 500)? Does CWM flag it?

Non-goals: no refit, no retune, no new calibration id, no composite-score optimization (`CONTRIBUTING.md` rule 1). The composite is reported, never a criterion (`typical/PREREGISTRATION.md` §9.4).

## 2. Fixed topology and the one variable

| Item | Value | Label |
| --- | --- | --- |
| Region | us-east-2 | [FACT: typical keys are locked there, `scripts/lib/adapter/version.mjs` `TYPICAL_REGION`] |
| Edge | internal ALB, HTTP:80 | [FACT: `terraform/alb.tf`] |
| **App count** | **1, 2 or 3** (`-var app_count=N`) | [DECISION]. The variable already exists (`terraform/variables.tf` `app_count`, default 2). `app.tf` and the target-group attachment already use `count = var.app_count` [FACT] |
| App instance | m5.large, AL2023, Node 20, gp2 30 GiB | [FACT: `terraform/variables.tf`] |
| AMI | **pinned** (`-var ami_id=<AMI>`), one id for all 9 applies | [DECISION]. The SSM parameter drifts: typical-v1 got `ami-08be4b1b8afa29958`, the holdouts got `ami-0d3d85815a9746bc5` [FACT: `typical/REPORT.md`] |
| App profile / workers | `typical`, 2 Node workers per server | [FACT/DECISION, unchanged from typical-v1] |
| Per-node pool | **250 per node** (125 per worker), held fixed | [DECISION, §2.1] |
| `APP_QUEUE_LIMIT` | 50 per worker | [FACT: default] |
| DB | db.r5.large, MySQL 8.0, Single-AZ, gp2 100 GiB, `max_connections` 500 | [FACT: `terraform/variables.tf`, `rds.tf`] |
| DB minor version | record per apply. Optionally pin the exact minor (D11) | [ASSUMPTION: `db_engine_version="8.0"` lets AWS pick the current minor, and `auto_minor_version_upgrade = true`, so it can differ between applies] |
| Generator | c6i.xlarge, k6 v0.54.0 | [FACT] |
| Mix, dataset, protocol | `load/typical.js` 59/20/10/10/1; `seed-typical.sql`; 5 min warmup + 15 min steady | [FACT: unchanged, `typical/PREREGISTRATION.md` §4–§6] |

Per-node load [DERIVED: total RPS ÷ N]:

| Total RPS | 1× per node | 2× per node | 3× per node |
| ---: | ---: | ---: | ---: |
| 100 | 100 | 50 | 33.3 |
| 200 | 200 | 100 | 66.7 |
| 300 | **300** | 150 | 100 |

The highest per-node rate measured so far is 250/node (`typical-saturation-500`: app CPU 26.34%, P95 88.19 ms, error 0.0103%) [FACT: `typical/REPORT.md`]. **1×-300 is beyond any measured per-node rate.** 1×-200 is beyond the fitted per-node range (fit rungs reached 100/node).

### 2.1 Connection-pool decision: hold the per-node pool at 250 [DECISION, recommended; D2]

| Config | Potential app sessions | vs `max_connections` 500 | Binding limit during a connection spike |
| --- | ---: | --- | --- |
| 1× | 1 × 250 = 250 | below | **app pool** (125 per worker, then the mysql2 queue of 50 per worker, then `queue_full`) |
| 2× | 2 × 250 = 500 | equal (the declared pairing, `terraform/README.md`) | both |
| 3× | 3 × 250 = **750** | **above** | **MySQL** (`too_many_connections`) |

Why hold it fixed rather than cap the total (for example `app_pool_size=166`, so 3 × 166 = 498):
1. **One variable.** Only `app_count` changes. Each node runs the identical process model (2 × 125 pool, queue 50), so per-node behavior is comparable across configs. Capping would change per-worker pool size (125 → 83) at the same time as node count, and the delta could not be attributed.
2. **It is the real-world change.** "Add a server" clones the node config. The CWM graph models that the same way (`appDbPoolSize: 250` on each app; `typical/after-fit/create-payload-300.json`).
3. **Minimal wiring.** The adapter's `expectedPoolSize` stays 250 on every key. No per-config pool keys are needed.
4. **The risk is measurable rather than hidden.** mysql2 pools open connections on demand [ASSUMPTION: lazy creation up to `connectionLimit`], so steady-state sessions follow concurrency, not node count. The observed 2× steady-window max at 300 RPS was 253 / 428 / 348 [FACT: holdout report]. All of those happened in a one-minute spike (§10 R3). At 3×, a spike like the east later-day one (65 → 427) has about 73 sessions of headroom before 500. Each node may open up to 250, so a larger spike can exceed the cap. RDS also uses some connections for its own admin sessions [ASSUMPTION], so usable headroom is slightly below 500.

**Pre-declared:** `too_many_connections` errors at 3× and `queue_full` / pool-wait latency at 1× are **results, not invalidations**. They are reported by class and never re-run away (`typical/PREREGISTRATION.md` §10). Every collect records DB connections avg/max, and the per-minute series around the spike minute is kept for every rung.

The CWM-side counterpart: for the 3× graph, CWM should report `declaredFleetConnectionBudget` = 3 × 250 = 750 against `maxConnections` 500. The connector describes this as a plan-time worst case that does not change CPU, latency or error outputs unless `connectionDemand` is declared [FACT: user-cwm tool description]. It is recorded as a prediction-side flag (claim C12). No `connectionDemand` is declared, to keep the graph identical to the 2× owned graph except for N.

## 3. Configuration and rung matrix

| Apply id (`test_id` / `CWM_CAMPAIGN_ID`) | N | Rungs, in order | Keys |
| --- | ---: | --- | --- |
| `typical-scale-1x-r{1,2,3}-YYYYMMDD` | 1 | 100 → 200 → 300 | `typical-scale-1x-100`, `typical-scale-1x-200`, `typical-scale-1x-300` |
| `typical-scale-2x-r{1,2,3}-YYYYMMDD` | 2 | 100 → 200 → 300 | `typical-scale-2x-100`, `typical-scale-2x-200`, `typical-scale-2x-300` |
| `typical-scale-3x-r{1,2,3}-YYYYMMDD` | 3 | 100 → 200 → 300 | `typical-scale-3x-100`, `typical-scale-3x-200`, `typical-scale-3x-300` |

Totals: **9 applies, 27 rungs, 27 × 20 min = 9 h of load** [DERIVED].

- **Ladder history is identical on every apply** [DECISION]: fresh deterministic seed, then 100 → 200 → 300 on the same stack. The 300 RPS rung always starts with about 50,000 + 10,500 + 21,000 = **81,500** comment rows [DERIVED from `typical/PREREGISTRATION.md` §7.3]. Comment inserts depend on total RPS, so this is the same for every N. For comparison, the original `typical-holdout-300` started at about 83,600 (after 20/100/200) and the holdout 300 rungs at about 60,500 (after 100 only). The 2× reps here are the closest re-measurement of `typical-holdout-300` to date.
- **Why new 2× keys rather than re-using `typical-fit-100/200` and `typical-holdout-300`:** those carry `split: fit` for 100/200. `run.mjs` would then write `fitCampaignDateUtc` into adapter state and tag k6 `SPLIT=fit`. This campaign is validation, so every new key is `split: holdout` [DECISION].
- **Session layout (Latin square)** [DECISION; D4]. Each session runs one rep of each config, and each config takes each position once:

  | Session | 1st apply | 2nd apply | 3rd apply |
  | --- | --- | --- | --- |
  | S1 (rep 1) | 2× | 1× | 3× |
  | S2 (rep 2) | 1× | 3× | 2× |
  | S3 (rep 3) | 3× | 2× | 1× |

  Sessions may fall on different UTC days. That is intended: day-to-day drift (later-day k6 P50 +16% at 100 RPS [FACT]) then becomes part of the rep-to-rep noise, and the within-session pairing in §7.3 can remove it.

### 3.1 Reps: three separate applies, not three passes on one apply [DECISION, recommended; D3]

| | **9 separate applies (recommended)** | 3 applies × 3 passes |
| --- | --- | --- |
| Independence | Each rep gets new instances, new host placement, a new RDS instance, a fresh seed and cold pools. This is the same kind of variation behind the 1.9× P95 spread we need to beat. | Reps share hosts and DB. Pass 2 and 3 start with warm buffer pools, about 113,000 → 176,000 comment rows, and mysql2 pools that may still hold the previous 300 rung's spike connections. Rep is confounded with history, and within-apply spread likely **understates** between-apply noise. |
| "300 always follows the same history" | Exactly true | False for passes 2 and 3 |
| Wall time [DERIVED, §8] | about 11.5–12.5 h | about 10.2 h |
| Kevin hands-on | 9 apply/destroy cycles. The runner automates them; Kevin starts each session and reviews the checks | 3 cycles |

The holdouts measured about 7 min per apply and about 4–6 min per destroy [FACT: `typical/campaign/typical-holdouts-v1-20261006/README-execution.md`]. Independence therefore costs only about 1.5–2 h of wall time and a few check-ins. It is the only design that can answer "does the change exceed run-to-run noise" with noise of the right kind.

Parallel applies (all three configs at once) are **not** recommended. ALB and target-group names are fixed (`${name_prefix}-alb`, `${name_prefix}-app`, with `name_prefix` default `cwm-bench`; `terraform/alb.tf`, `locals.tf`), so two stacks in us-east-2 collide unless `name_prefix` changes. The runner also needs separate backend schemas per apply [FACT: holdout execution README].

## 4. Metrics

Same collector as typical-v1 [FACT: `scripts/lib/adapter/collect.mjs`]:
- **Primary:** app CPU (mean of the N hosts, steady window; also per host), k6 P50 / P95 / P99, goodput (whole-run, the basis of the existing scores), error rate (`http_req_failed` × 100) and error classes, DB CPU, DB connections avg/max.
- **Secondary:** ALB TargetResponseTime p50/p95/p99, ALB/target 5xx, generator CPU avg/peak, k6 dropped iterations and peak VUs, RDS and app EBS BurstBalance minimum (`iops_throttle` bucket, `CONTRIBUTING.md` rule 6), and **per-minute DB connections and ALB p95/p99** to locate the spike minute.
- **Per-host CPU at 3×** matters because placement is asymmetric: `aws_subnet.public[count.index % 2]` puts app-0 and app-2 in AZ a and app-1 in AZ b. The DB is in `azs[0]` [FACT: `terraform/app.tf`, `rds.tf`]. See R9.

## 5. Prediction freeze (before any apply)

### 5.1 Procedure [DECISION]
1. **Graphs.** Start from `typical/after-fit/create-payload-<RPS>.json` for RPS ∈ {100, 200, 300} [FACT: those payloads are the 2× owned graph]. Change only the app tier:
   - resources `app-1 … app-N`, each with characteristics identical to the existing app nodes (m5.large, `serviceFamily: ec2`, `autoscaling: false`, `workload: crud-typical`, `appRuntime: node`, `appWorkerCount: 2`, `appDbPoolSize: 250`, `regionKey: us-east-2`);
   - connections `alb → app-i` and `app-i → db` for each i;
   - `minInstances = maxInstances = N`.

   Keep everything else unchanged: `appWeight: typical`, `seed: 20240601`, ALB `internal` with `serviceFamily: alb`, DB db.r5.large `serviceFamily: rds` with MySQL `8.0` and `maxConnections: 500`. The `instanceCount` shortcut is not used, so the 2× graph stays byte-identical to the published one apart from the name field.
2. **Calls (user-cwm MCP, same as `typical/after-fit/README.md`).** `simulation.create` → `simulation.step` once → harvest → `simulation.cost_breakdown` → delete. The committed freeze has **one** simulation per cell (`call-log.json`). Run B was not in the package. Do not invent a second run. 1×/3× bodies were recovered from list/snapshot/`cost_breakdown` because the connector enum rejected `owned-scaled` before step/get returned a body.
3. **Record per cell:** `engineVersion`, `effectiveConfigHash`, `calibrationEvidence.kind`, the calibration id and note, `loadScope`, app CPU per resource and mean, P50/P95/P99, throughput/`goodputRps`, `errorRate` and `errorBreakdown`, `costPerHour`, the cost breakdown (egress line separate), DB CPU, `databaseConnectionDemand` (`loadDerivedConnections`, `declaredFleetConnectionBudget`), and the `predictionEvidence` low/central/high ranges.
4. **Engine-drift gate.** Passed at this freeze. Engine moved from 1.2.5 (after-fit call-log) to **1.2.14** with no scored-field drift on the three 2× cells. They reproduce `typical/scores-after-fit.json` `pred` on cpu, P50, P95, throughput, error, DB CPU, and cost. P99 matches that file at the call-log display precision (full precision is in `predictions.json`). The gate that had to hold before freezing:

   | RPS | cpu | p50 | p95 | p99 | thr | err | db | cost |
   | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
   | 100 | 5.215 | 4.879573 | 9.234496 | 81.72693 | 87.619644 | 0 | 11.4 | 0.6 |
   | 200 | 9.978 | 4.522397 | 11.009235 | 87.10212 | 175.11183 | 0 | 18.6 | 0.74 |
   | 300 | 14.74 | 4.1652207 | 12.783974 | 92.47731 | 262.604 | 0 | 25.8 | 0.88 |

   They matched. The new version is recorded as 1.2.14 and the cells are frozen.
5. **Commit** is this freeze: `typical/scale-v1/predictions/predictions.json` (canonical), `FROZEN.md`, `call-log.json`, and `create-payload-<N>x-<RPS>.json`. Full `simulation.metrics` bodies were not in the freeze package and are not reconstructed. That commit's SHA is `app_source_git_ref` for all 9 applies.
6. **Engine pin = the frozen numbers.** The live engine cannot be pinned by the caller. Scoring uses only `predictions.json`. A re-query after the campaign may be reported only as "post-measurement predictions, not scored".

### 5.2 Frozen prediction table

Filled from `typical/scale-v1/predictions/predictions.json` (engine 1.2.14, 2026-10-06 12:41:17 EDT). These are the scored numbers. `errorRate` is **0** on every cell. 1× and 3× carry pool-capacity warnings and do not predict connection-class errors. 1×-200 and 1×-300 are **unvalidated extrapolations**: equivalent two-server fit load 400 RPS and 600 RPS, beyond the 300 RPS independent holdout, with P50 capped at its 300 RPS projection.

`costPerHour` is the connector display. `cost Σ` is `costBreakdownTotal` (the breakdown sum, which includes modeled egress). This freeze does not re-derive a no-egress split. The after-fit no-egress reference 0.4545 at 2×-300 stays in `typical/after-fit/` and is not a new number. Fleet connection budget is the graph declaration N × 250. It was not a separate harvested field; the pool warnings state the 1× ceiling of 250 and the 3× combined pool of 750 against `max_connections` 500.

| Cell | kind | engine | CPU % | P50 ms | P95 ms | P99 ms | thr | err % | DB CPU | costPerHour / cost Σ | fleet conn budget |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 1×-100 | owned-scaled | 1.2.14 | 9.978 | 4.522396967213114 | 11.009235083606534 | 87.10211997786887 | 87.555916 | 0 | 11.4 | 0.5 / 0.500341 | 250 |
| 1×-200 | owned-scaled | 1.2.14 | 19.502 | 4.165220860655737 | 14.558712477049129 | 97.85249770901643 | 175.0481 | 0 | 18.6 | 0.64 / 0.642078 | 250 |
| 1×-300 | owned-scaled | 1.2.14 | 29.027 | 4.165220860655737 | 18.108189870491724 | 108.60287544016398 | 262.54028 | 0 | 25.8 | 0.78 / 0.783815 | 250 |
| 2×-100 | owned | 1.2.14 | 5.215 | 4.879573 | 9.234496 | 81.72693111229509 | 87.619644 | 0 | 11.4 | 0.6 / 0.596444 | 500 |
| 2×-200 | owned | 1.2.14 | 9.978 | 4.522397 | 11.009235 | 87.10211997786887 | 175.11183 | 0 | 18.6 | 0.74 / 0.738181 | 500 |
| 2×-300 | owned | 1.2.14 | 14.74 | 4.1652207 | 12.783974 | 92.47730884344264 | 262.604 | 0 | 25.8 | 0.88 / 0.879919 | 500 |
| 3×-100 | owned-scaled | 1.2.14 | 3.628 | 4.998631775956284 | 8.64291682131147 | 79.93520149043717 | 87.68337 | 0 | 11.4 | 0.69 / 0.692547 | 750 |
| 3×-200 | owned-scaled | 1.2.14 | 6.803 | 4.760514371584699 | 9.826075952459002 | 83.51866073415302 | 175.17555 | 0 | 18.6 | 0.83 / 0.834284 | 750 |
| 3×-300 | owned-scaled | 1.2.14 | 9.978 | 4.522396967213114 | 11.009235083606534 | 87.10211997786887 | 262.66776 | 0 | 25.8 | 0.98 / 0.976022 | 750 |

### 5.3 Secondary reference predictor: the owned CPU fit scaled per node [DERIVED, not a criterion]
An OLS fit of measured 2× app CPU on per-node RPS over the three fit rungs only (10 / 50 / 100 per node → 1.3926 / 5.2381 / 9.9673%) gives CPU ≈ 0.45291 + 0.095246 × r_node. It reproduces CWM's owned 2× predictions to 3 decimals (5.215 / 9.978 / 14.74). This suggests the owned CPU fit is linear in per-node RPS. Applied per node:

| | 100 | 200 | 300 |
| --- | ---: | ---: | ---: |
| 1× (r = 100 / 200 / 300) | 9.978 | 19.502 | 29.027 |
| 2× | 5.215 | 9.978 | 14.74 |
| 3× (r = 33.3 / 66.7 / 100) | 3.628 | 6.803 | 9.978 |

This "what a scaled-from-owned CPU model would say" reference is scored alongside the as-shipped CWM prediction. It lets the report say whether CWM's as-shipped answer beats simple per-node scaling of its own fit. It uses only fit-split data and is fixed now.

### 5.4 Prediction basis (decision D1, decided)
The connector's documented owned-typical gate requires the exact four-node graph with **two** apps and `minInstances = maxInstances = 2` [FACT: user-cwm `simulation.create` description]. Before engine 1.2.14, 1× and 3× fell back to generic `modeled` (§5.5). **D1 is decided: B.** The owned-scaled path for N ≠ 2 shipped as engine **1.2.14** before this freeze, and before any apply. Pre-declared handling, updated for that ship:
- **Primary = as-shipped on 1.2.14.** Score the frozen cells: owned 2× against owned-scaled 1× and 3×. The report labels every cell with its `kind`. The bases differ (`owned` vs `owned-scaled`); say so. They are not the generic modeled fallback.
- No graph tweak was made to force a basis.
- 1×-200 and 1×-300 remain unvalidated extrapolations inside that owned-scaled path (per-server load beyond the fit and the 300 RPS holdout). Pool warnings are prediction-side flags. Predicted errors are 0.

### 5.5 UNFROZEN prediction check, 2026-10-06 (NOT the freeze; historical, for the D1 record)

> **Unfrozen check.** This is not the §5.2 frozen table, and it must not be scored. It was engine 1.2.13 and `modeled` on 1×/3×. The freeze that replaced it is engine 1.2.14 `owned` / `owned-scaled` (§5.2). It was run with one simulation per cell, with no run B and no commit. All 9 simulations were deleted afterwards. Raw data for this unfrozen check was not committed with the freeze.

**⚠ Engine changed.** Every cell returned `engineVersion` **1.2.13**. The frozen reference, `typical/after-fit/call-log.json` @ `f859f540ef4ef4e12ad54f350e0ca84be5a20932`, is **1.2.5**. All scored 2× outputs still match it exactly. `effectiveConfigHash` and the calibration note text differ.

| Cell | calibrationEvidence.kind | CPU % / host | P50 ms | P95 ms | P99 ms | thr | errorRate | DB CPU % | cost $/h | fleet conn budget | engine |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1×-100 | modeled | 39.777 | 18 | 45 | 169 | 100 | 0 | 1.3 | 0.52 | 250 | 1.2.13 |
| 1×-200 | modeled | 79.33 | 18 | 44 | 265 | 200 | 0 | 4.6 | 0.68 | 250 | 1.2.13 |
| 1×-300 | modeled | 100 (critical) | 17 | 42 | 382 | 270 | 10 (cpuOverload) | 8.1 | 0.8 | 250 | 1.2.13 |
| 2×-100 | owned | 5.215 | 4.879573 | 9.234496 | 81.72693 | 87.619644 | 0 | 11.4 | 0.6 | 500 | 1.2.13 |
| 2×-200 | owned | 9.978 | 4.522397 | 11.009235 | 87.10212 | 175.11183 | 0 | 18.6 | 0.74 | 500 | 1.2.13 |
| 2×-300 | owned | 14.74 | 4.1652207 | 12.783974 | 92.47731 | 262.604 | 0 | 25.8 | 0.88 | 500 | 1.2.13 |
| 3×-100 | modeled | 13.408 | 18 | 45 | 144 | 100 | 0 | 2.7 | 0.71 | 750 | 1.2.13 |
| 3×-200 | modeled | 26.592 | 18 | 44 | 172 | 200 | 0 | 6 | 0.87 | 750 | 1.2.13 |
| 3×-300 | modeled | 39.777 | 17 | 42 | 202 | 300 | 0 | 9.4 | 1.04 | 750 | 1.2.13 |

What the check found:
- **§5.4 is confirmed.** In 1× and 3×, the engine's note gives the exclusion reasons: resources count, `minInstances`/`maxInstances`, compute count, and the edge shape. `loadScope` is `not calibrated`, and `sourceIds` include `cwm-industry-guidance-placeholder-v1`. Generic CPU is the engine-1.2.3 per-host curve, 3.7–4.1× the §5.3 per-node-scaled reference.
- **The 2→3 CPU delta is sign-wrong by construction.** At 300 RPS, per-host CPU goes 14.74 → 39.777, and at 200 RPS it goes 9.978 → 26.592.
- **The 2→1 deltas are basis artifacts.** Latency jumps about 4× and DB CPU drops 2.7–8.8× at the same RPS.
- **1×-300 predicts saturation:** 10% errors and 270 rps throughput.

## 6. Frozen claims (pass/fail criteria are in §7)

| # | Claim / test | Metric(s) | Criterion | Role |
| --- | --- | --- | --- | --- |
| C1 | 2× reproduces existing typical | CPU, P50, P95, goodput, errors, DB CPU at 100/200/300 | 2× median lies within [min ÷ R, max × R] of the existing 2× runs at that rate (100: fit-100 + 2 holdouts; 300: holdout-300 + 2 holdouts; 200: fit-200 only, using R from 100/300). Outside that range raises a `BASELINE_DRIFT` flag (reported, not a failure) | Primary, descriptive |
| C2 | Absolute accuracy per cell | Page per-metric scores + composite (both cost bases) + P99 diagnostic | None (per §9.4 of the typical prereg). 2×-100/200 are labeled "fit-condition repeat"; 2×-300 "holdout-condition repeat"; 1×/3× "validation" | Primary, descriptive |
| C3 | 2→1 CPU change | app CPU | Direction correct AND magnitude within tolerance (§7.2) at each rung | **Primary** |
| C4 | 2→3 CPU change | app CPU | same | **Primary** |
| C5 | 2→1 P95 change | k6 P95 | same | **Primary** |
| C6 | 2→3 P95 change | k6 P95 | same | **Primary** |
| C7 | 2→1 / 2→3 goodput change | goodput | Absolute change within ±1 percentage point of measured | **Primary** |
| C8 | 2→1 / 2→3 error change | error rate | Absolute change within ±0.01 pp of measured (the page's error tolerance) | **Primary** |
| C9 | Diminishing returns at 3× | P95 (P50 secondary), DB CPU, DB conns | §7.4 | **Primary** |
| C10 | P50 change | k6 P50 | as C3/C4 | Secondary |
| C11 | DB-side invariance | DB CPU | Measured DB CPU change 2→1 and 2→3 within the DB noise band; CWM's predicted DB CPU change compared the same way | Secondary |
| C12 | Connection limits | DB conns max, `too_many_connections`, `queue_full` | Descriptive: report counts by class per cell; report whether CWM predicted any connection-class error, and its `declaredFleetConnectionBudget` | Secondary |
| C13 | Naive scaled-fit reference (§5.3) | CPU | Same C3/C4 criteria applied to the reference | Secondary |

**Transition verdicts** (one each for 2→1 and 2→3):
- "**CWM predicts the change**" requires all of: direction correct for CPU, P95, goodput and errors at all three rungs where direction is judgeable; CPU magnitude within tolerance at all three rungs; P95 magnitude within tolerance at ≥ 2 of 3 rungs; C7 and C8 pass at all rungs.
- "**Direction only**" means all directions are correct but a magnitude criterion fails.
- Otherwise "**Does not predict the change**", with each failing cell listed.

All cells are published whatever the outcome (§10 of the typical prereg).

## 7. Scoring method and statistics

### 7.1 Absolute (page-style, unchanged)
Per metric `max(0, 100 − |pred − meas| / |meas| × 100)`, rounded to 1 decimal. The error rule is 100 if |Δ| ≤ 0.01 pp, else `max(100 × 0.01 / |Δ|, relative accuracy)`. Weights are P50 0.20, P95 0.25, CPU 0.20, throughput 0.15, error 0.10, cost 0.10. The no-cost total divides by 0.9 [FACT: `typical/after-fit/score_export.py`]. Throughput is whole-run goodput. Each cell is scored on the **median of its 3 reps**, and each rep is also scored individually (min/max of the per-rep scores reported). Cost has two bases: connector (`costPerHour`) and no-egress (breakdown total minus egress). The list-price reference scales with N: 0.0225 + N × 0.096 + 0.24 = **0.3585 / 0.4545 / 0.5505** USD/h for 1× / 2× / 3× [DERIVED from `typical/REPORT.md` prices]. A new script, `typical/scale-v1/score_scale.py`, imports `rel`, `errs` and `W` from `score_export.py` unchanged.

### 7.2 Delta accuracy
For config c ∈ {1×, 3×}, rung r and metric m:
- Measured ratio `ρ_meas = median_c / median_2×`. Predicted ratio `ρ_pred = pred_c / pred_2×`. Both are also reported as % change (ρ − 1) × 100. Error rate and goodput use **absolute differences** in percentage points instead of ratios.
- **Noise band B** (single-run max/min of the three existing 2× runs at that rate [DERIVED from `typical/scores-holdouts-v1-20261006.json` and `scores-after-fit.json`]):

  | Metric | B at 100 | B at 300 | B at 200 (no triplet; use the larger) | Magnitude tolerance |
  | --- | ---: | ---: | ---: | --- |
  | App CPU | 1.093 (5.238–5.725) | 1.051 (15.30–16.09) | 1.093 | ratio-of-ratios within **±20%** (B²: 1.195 at 100, 1.105 at 300, rounded up) |
  | k6 P50 | 1.200 (4.531–5.440) | 1.120 (4.622–5.175) | 1.200 | within **×/÷ 1.45** (B² = 1.44) |
  | k6 P95 | 1.283 (7.63–9.79) | **1.899** (26.92–51.12) | 1.899 | within **×/÷ 2.0** ("rough size"; B² = 1.65 at 100, 3.61 at 300; see D7) |
  | DB CPU | 1.172 | 1.176 | 1.176 | within ×/÷ 1.38 (B²) |
  | Goodput | 1.00004 | 1.00023 | — | absolute, ±1 pp |
  | Error rate | spread 0.0029 pp | spread 0.0029 pp | — | absolute, ±0.01 pp |

  The campaign's own 2× reps give a second estimate. The **detection** band used is `max(B_prereg, campaign 2× max/min at that rung)`. That can only make detection stricter. Magnitude tolerances are fixed now and are not updated from campaign data.
- **Measured direction** per metric × rung:
  - **up/down:** all 3 reps of c lie beyond the full range of the 3 reps of 2× in that direction (complete separation), AND ρ_meas lies outside [1/B, B];
  - **none:** ρ_meas lies within [1/B, B] (for goodput, within ±1 pp; for errors, |Δ| ≤ 0.01 pp);
  - **indeterminate:** anything else. Direction is not judged there; the cell is reported.
- **Predicted direction:** up/down if ρ_pred lies outside [1/B, B] (same B), otherwise none.
- **Direction correct** means the categories match. **Magnitude** is judged only when the measured direction is up or down: `|ρ_pred / ρ_meas − 1| ≤ tolerance` (CPU), or `ρ_pred / ρ_meas ∈ [1/T, T]` (P50, P95, DB CPU). The report also shows predicted vs measured % change and their difference in percentage points.
- **Expected-size sanity (not a criterion):** CPU should move by far more than its band (per-node load halves or doubles; §5.3 reference ratios 2→1 ≈ 1.91–1.97, 2→3 ≈ 0.68–0.70). Goodput should show no change unless 1×-300 saturates. The P95 change at 300 may be inside the 1.9× band, in which case "none / indeterminate" is the honest outcome.

### 7.3 Statistics with n = 3
- Per cell: **median, min, max and all three values**. No means or SDs.
- Change: the ratio of medians, plus the **extreme-pair interval** [min_c / max_2×, max_c / min_2×] as a conservative bound.
- Exceeding noise: complete separation of 3 vs 3 is the strongest evidence n = 3 allows. The exact permutation probability under "no difference" is 1 / C(6,3) = **1/20 = 0.05 one-sided** (0.10 two-sided) [DERIVED]. It is reported as such, with no further p-values.
- Paired secondary: each session holds one rep of every config (§3), so the 3 within-session ratios c_k / 2×_k are also reported, together with their median. If paired and unpaired directions disagree, the cell is marked "session-sensitive".

### 7.4 Diminishing returns (C9)
At each rung, for P95 (P50 secondary): gain₁₂ = P95(1×) / P95(2×) and gain₂₃ = P95(2×) / P95(3×), using medians.
- **Measured DR holds** if 2→1 is "up" (worse with one server) and 2→3 is "none" or gain₂₃ < gain₁₂, AND DB CPU is "none" for both transitions (the DB-side load is unchanged, consistent with a DB- or tail-limited regime).
- **CWM captures DR** if predicted gain₂₃ < predicted gain₁₂ AND the predicted 2→3 P95 category equals the measured one.
- DR is reported as holding, not holding, or indeterminate per rung. There is no measured basis yet to expect either outcome; DB CPU at 2×-300 was 26.7–31.4%, not saturated [FACT].

## 8. Run plan

### 8.1 Before session 1 (once)
1. Land the wiring PR (§9). CI green (`bash scripts/ci.sh`; adapter tests).
2. The prediction freeze (§5) is in this commit, with this prereg finalized. **That SHA = `measurement_sha`.**
3. Resolve the AMI once, before session 1 (`aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --region us-east-2`). This commit does not query AWS, so the id is not written here. Record it in the campaign evidence and pass the same `-var ami_id=<AMI>` on all 9 applies (D9).
4. Record the MySQL 8.0 minor on every apply (D11). It is not pinned in Terraform: the current minor was not resolved without an AWS call.
5. Confirm the runner can proceed after a tag-inventory-lag cleanup (D10). The holdouts ended with "strict safety lock retained" [FACT: `typical/campaign/typical-holdouts-v1-20261006/README-execution.md`]. Proceed when direct checks classify every ARN terminated or not-found. Do not delete by hand outside Terraform.

### 8.2 Per apply (repeat 9 times in the §3 order)
```bash
APPLY=typical-scale-${N}x-r${K}-YYYYMMDD          # e.g. typical-scale-3x-r1-20261010
git clone https://github.com/canvascloudai/cwm-bench.git cwm-bench-$APPLY && cd cwm-bench-$APPLY
git checkout --detach <SHA> && test -f typical/scale-v1/PREREGISTRATION.md && mkdir -p out
export AWS_REGION=us-east-2 AWS_DEFAULT_REGION=us-east-2 CWM_CAMPAIGN_ID=$APPLY
unset CWM_WARMUP CWM_DURATION CWM_FIT_CAMPAIGN_DATE
node scripts/worker-adapter.mjs wait-ready --json > out/00-capability.json   # adapterVersion 1.5.0; 9 typical-scale-* keys listed
cd terraform && terraform init && terraform apply \
  -var='region=us-east-2' -var="test_id=$APPLY" -var='app_profile=typical' -var='app_workers=2' \
  -var="app_count=$N" -var="ami_id=<AMI>" -var='app_source_git_ref=<SHA>'
terraform output -json > ../out/01-terraform-outputs.json && cd ..
node scripts/worker-adapter.mjs wait-ready --json > out/02-wait-ready.json
aws rds describe-db-instances --region us-east-2 --query "DBInstances[?contains(DBInstanceIdentifier,'cwm-bench')].EngineVersion" > out/03-rds-engine-version.json
for RPS in 100 200 300; do
  KEY=typical-scale-${N}x-$RPS
  export CWM_SCENARIO=$KEY CWM_RUN_ID=$KEY-r$K
  node scripts/worker-adapter.mjs run --scenario $KEY --json > out/10-$KEY.run.json
  # set CWM_RUN_STARTED_AT / CWM_RUN_ENDED_AT from the generator's started_at / completed_at
  node scripts/worker-adapter.mjs collect --scenario $KEY --json > out/11-$KEY.collect.json
done
# destroy + leftover checks: typical/RUNBOOK-CANVASCLOUDAI.md section 8 with test_id=$APPLY and the same -var set
```
Do not change any other variable: instance types, `app_pool_size`, `mysql_max_connections`, `name_prefix`, warmup, duration.

**Gates (stop or record):**
- After apply: `topology_declaration.app_count == N`, `len(app_instance_ids) == N`, `resolved_ami_id == <AMI>`, `ami_source == "variable"`.
- After wait-ready: `ok`, and N `appNodes`, each `typical` / 2 workers / `<SHA>`.
- After each run: `ok: true`, and `adapterVersion` 1.5.0.
- After each collect: `ok`, `complete`, `identityMatches`, `invented: false`, generator CPU steady-window ≤ 70%, `terraformOutputs.topology_declaration.app_count == N`. **The collect window must cover only that rung.** `collectionWindow()` falls back to a trailing 40-minute window when `CWM_RUN_STARTED_AT` / `CWM_RUN_ENDED_AT` are unset [FACT: `collect.mjs`]. Started back-to-back, that window would span the previous rung, so check `cloudwatch.window.source == "persisted-run"` or that the window bounds match the run.
- Record per rung: k6 dropped iterations, peak VUs, error classes, the DB-connection spike minute.

**Re-run rules** [DECISION, extends typical prereg §10]:
- Generator CPU > 70%: discard, re-run that rung once on the same stack, then continue the ladder.
- Infra failure (SSM loss, `CLOUDWATCH_PARTIAL`, identity mismatch): if the k6 run itself completed, re-collect (do not re-run). If the load did not complete, re-run that rung once and label the rung "history-perturbed".
- If 100 or 200 cannot complete, destroy and repeat the **whole apply** as `…-r${K}a`.
- Errors, saturation or slow rungs are never re-run.
- Keep every attempt (`-attempt2` suffix).

### 8.3 Time estimate for Kevin [DERIVED]
Inputs [FACT]: holdout apply 7.0 / 7.1 min; run-to-run cadence 21.2 min per rung (20 min load + collect); destroy confirmed 4–6 min after the last rung; plus a 15-minute inventory recheck. The whole holdout campaign (2 applies, 4 rungs) took 02:15–04:26 UTC (one evening).

| Item | Estimate |
| --- | --- |
| Wiring PR (adapter 1.5.0, keys, tests, runbook §11, this prereg), mostly agent-written | ½ day of Kevin review |
| Prediction freeze (18 sims + drift gate + commit) | about 1 h |
| Per apply | 7 + 1 + 3 × 21.2 + 5 ≈ **76 min** |
| Per session (3 applies + final 15 min recheck) | about **4 h**. The per-TestId recheck of apply k can overlap apply k+1 |
| Runs total | 9 applies / 27 rungs / about **11.5–12.5 h** wall, as **3 evenings** (or one long day plus one evening). Kevin hands-on about 30–45 min per session if the runner drives the commands |
| Scoring + export + REPORT section | about ½ day, then index wait |
| **Calendar** | **about 1 working week** end to end (not the first-campaign week of harness building). Load-hours are about 6.75× the holdout campaign's |
| Alternative 3 applies × 3 passes | about 10.2 h runs (3 × (8 + 9 × 21.2 + 5) min). Saves about 2 h, loses independence (§3.1) |
| AWS | about 12 h × USD 0.53–0.72/h (1×–3×, runbook price basis incl. about 0.17 generator) ≈ **under USD 10** list price. Not the constraint |

## 9. Wiring changes (minimal, mirroring PR #15)

PR #15 added four keys under adapter 1.4.0 and kept 1.4.0 only because that version had not shipped yet [FACT: PR #15 body]. 1.4.0 has since run the holdout campaign, so new keys need **adapter 1.5.0** [DECISION]. `typical-v1-20260927c` stays at 1.3.0 and the holdouts stay at 1.4.0.

| File | Change |
| --- | --- |
| `scripts/lib/adapter/version.mjs` | `ADAPTER_VERSION = '1.5.0'`; comment naming the 9 `typical-scale-*` keys and the app-count assertion |
| `scripts/lib/adapter/scenarios.mjs` | Add 9 keys to `SCENARIO_KEYS`. New helper `typicalScaleScenario(key, appCount, rps)` returning `kind: 'holdout'`, `split: 'holdout'`, `regionRole: 'primary'`, `requiredRegion: TYPICAL_REGION`, `workload: {script: 'typical.js', envName: 'SCENARIO', envValue: key}`, `expectedPoolSize: 250`, `expectedProfile: 'typical'`, `expectedWorkers: 2`, **`expectedAppCount: N`**, `completeness: 'optional'`, `requiresCompleteCollect: false`, `aliasOf: null`. New `assertExpectedAppCount(spec, outputs)`: if `spec.expectedAppCount != null`, require `outputs.appInstanceIds.length === N` and `Number(outputs.topology.app_count) === N`, else throw **`APP_COUNT_MISMATCH`**. Extend `assertNotAliased` so scale keys must run `typical.js` with `SCENARIO=<own key>` |
| `scripts/lib/adapter/run.mjs`, `collect.mjs` | Call `assertExpectedAppCount` next to `assertTypicalRegion`. Optional: for scale keys, read `/api/meta` on **every** node (today `run` checks only `appInstanceIds[0]`) |
| `scripts/lib/adapter/ready.mjs` | `matrixNote` mentions the scale keys; per-scenario `expectedAppCount` in the capability payload |
| `load/lib/common.js` | Add the 9 keys to `TYPICAL_RPS` (`load/typical.js` throws on unknown `SCENARIO`). `vuBudget` unchanged (300 RPS → 400 pre-allocated / 800 max VUs) |
| `schema/` run enum, CLI help, `README.md`, `scripts/README.md`, `load/README.md` | List the keys, as PR #15 did |
| `tests/adapter/*.test.mjs` | Scale keys accepted in us-east-2 with matching `app_count`; `APP_COUNT_MISMATCH` on mismatch (for example a 2-node stack with `typical-scale-3x-300`); `TYPICAL_REGION_CONSTRAINT` in us-west-2; `PROFILE_MISMATCH` on lean; `POOL_MISMATCH` on 40; k6 started with the key's RPS; `adapterVersion` 1.5.0; capability lists all keys |
| `terraform/` | **No functional change.** `app_count` already drives `aws_instance.app`, target-group attachments, dashboard widgets and outputs. Optional (D6): `locals.tf` `Topology` tag is hard-coded `alb-2x-…`. Make it `alb-${var.app_count}x-…`, which renders identically at N = 2 |
| `typical/RUNBOOK-CANVASCLOUDAI.md` | New §11 with §8.2 above |
| `typical/PREREGISTRATION.md` | Optional one-line §13 pointer to `typical/scale-v1/PREREGISTRATION.md`. §3–§9 and §12 untouched (§12.5 already says 1×/3× is a different topology) |
| Optional (D5) | Add `expectedAppCount: 2` to the existing `typical-*` keys. Today the adapter would happily run `typical-holdout-300` on a 3-node stack and label it as typical-v1. The guard can only reject such mislabeled runs |

## 10. Risks and gotchas

| # | Risk | Handling |
| --- | --- | --- |
| R1 | **Basis**: 1×/3× are owned-scaled on engine 1.2.14, not the generic model (§5.4) | D1 decided before freeze. Label `kind` per cell. The 1.2.13 modeled check is not scored |
| R2 | **3× can exceed `max_connections`** (750 potential vs 500) | Declared in §2.1. Errors by class are results. Per-minute connections are kept |
| R3 | **One-minute DB-connection spike on every 300 RPS run** (53→252, 65→427, 74→297→348; ALB p99 0.9–1.9 s) [FACT] | Kept, never excluded. Report the spike minute per rep. P95 at 300 is expected to be noisy (§7.2 band 1.9×) |
| R4 | **1×-300 saturation / pool limit**: 300 per node is above anything measured; one node's 250-session pool vs a spike that reached 427 across two nodes | Declared: `queue_full`, dropped iterations and goodput loss are results. If in-flight demand exceeds 800 VUs (≈ 2.67 s mean latency at 300 RPS [DERIVED]), k6 drops iterations; these are counted against goodput, not discarded |
| R5 | **AMI drift** | Pin `ami_id` (§8.1). Gate on `ami_source == variable` |
| R6 | **DB minor-version drift** (`8.0` + auto minor upgrade) | Record per apply; optional pin (D11) |
| R7 | **Seed / comment drift**: each apply reseeds deterministically, and comments grow identically per ladder for every N (§3). k6 uses unseeded `Math.random()` [FACT: `load/typical.js`], so request sequences differ by run | Accepted. This is part of rep noise |
| R8 | **Generator capacity** | c6i.xlarge ran 4.8–5.0% at 300 RPS [FACT]. Discard rule > 70% unchanged |
| R9 | **AZ placement asymmetry**: app-i goes to subnet `i % 2`; DB is in AZ a. Same-AZ share of app→DB traffic is 100% at 1×, 50% at 2× and 67% at 3× (ALB spreads evenly across targets [ASSUMPTION: ALB cross-zone on by default]) | Disclosed confound for small latency deltas; per-host CPU and latency reported. Not changed (minimal wiring) |
| R10 | **Mis-labeled runs**: a typical key on the wrong app count | `APP_COUNT_MISMATCH` on every typical key (§9) + gates (§8.2) |
| R11 | **Collect window bleed** (trailing 40-minute fallback) | Gate in §8.2 |
| R12 | **Cleanup**: 9 destroys; tag inventory lag left 14–16 ARNs per region, and the runner exited 1 with its lock retained [FACT] | Per-apply direct checks (EC2 non-terminated, RDS, volumes, SG rules); proceed when all ARNs classify terminated/not-found (D10). Never delete by hand outside Terraform |
| R13 | **Engine moves between freeze and scoring** | Score only frozen numbers (§5.1 step 6) |
| R14 | **Day/time effects across sessions** | Latin square + paired within-session ratios (§7.3) |
| R15 | **Existing artifacts quirk**: stray `}` / `],` entries in `artifacts.files` [FACT] | Ignore; summary and identity are authoritative |
| R16 | **Fit-condition cells**: 2×-100/200 cells repeat fit rungs, so close agreement there is not evidence | Labeled in C2 |

## 11. Out of scope
- The live 2 → 1 → 2 failure-and-recovery test (later follow-up).
- Any coefficient, calibration-id or engine change based on this data. If a future fit ever uses these runs, it needs a new measurement id, and these runs then stop being holdouts for it.
- 20 RPS and 500 RPS rungs; us-west-2; burst; diagnostics; pool-size or worker-count variants.
- Resolving the known P95 miss at 300 RPS (pred 12.78 vs 26.92 / 51.12 / 32.89 measured) or the 500 RPS false saturation.

## 12. Decisions (recommended default in **bold**; recorded at freeze)

**Recorded 2026-10-06.** D1 is **B**: the owned-scaled model shipped as engine 1.2.14 before this freeze. D2, D3, D4, D7, D8, D10, and D12 stay at the bold defaults. D5 is yes (existing typical keys expect 2 app servers). D6 is yes (the `Topology` tag uses `app_count` and is unchanged at N = 2). D9: one AMI for all 9 applies, resolved before session 1 and not written in this commit. D11: record the MySQL minor per apply; it is not pinned here.

| # | Decision | Options | Recommended default and why |
| --- | --- | --- | --- |
| D1 | Prediction basis if 1×/3× come back `modeled` | A: freeze and test as shipped. B: add a scaled-from-owned engine path for N ≠ 2 first, then freeze | **Decided: B.** Owned-scaled shipped as engine 1.2.14 before the freeze (§5.2). The 1.2.13 `modeled` check (§5.5) is not scored. |
| D2 | Pool at 3× | Hold 250/node (750 > 500) vs cap the total (166/node) vs raise `max_connections` | **Hold 250/node.** One variable changes, it matches the real "add a server" change, and the risk is declared (§2.1) |
| D3 | Reps | 9 separate applies vs 3 applies × 3 passes | **9 separate applies.** About 2 h more wall time, but independent reps and identical warm-up history (§3.1) |
| D4 | Sessions | 3 evenings, Latin square vs 2 sessions | **3 sessions of about 4 h, Latin square** |
| D5 | Guard existing typical keys with `expectedAppCount: 2` | yes / no | **Yes.** It can only reject mislabeled stacks |
| D6 | `Topology` tag uses `app_count` | yes / no | **Yes.** Identical at N = 2, tag-only |
| D7 | P95 magnitude tolerance | ×/÷ 2 at all rungs vs direction-only at 300 | **×/÷ 2 everywhere**, with the caveat that at 300 RPS this is tighter than single-run noise (B² = 3.6), so a correct model can fail on noise. The median of 3 mitigates this |
| D8 | Where the prereg lives | new `typical/scale-v1/PREREGISTRATION.md` + §13 pointer vs a §13 amendment | **New file + one-line pointer** (1×/3× is a different topology per §12.5) |
| D9 | AMI | resolve before session 1 vs reuse `ami-0d3d85815a9746bc5` (holdouts) | **Resolve before session 1, one id for all 9.** Not written in this commit (no AWS query). Record it in the campaign evidence. Do not edit §2–§8 after the measurement SHA to store it |
| D10 | Runner strict cleanup lock between applies | proceed after direct-check reconciliation vs wait for an empty tag inventory | **Proceed after direct checks classify every ARN terminated/not-found**, recorded per apply |
| D11 | Pin the exact MySQL minor | yes / no | **Record per apply.** Pinning was not cheap here: the current minor was not resolved without an AWS call |
| D12 | Extra rungs (20 / 500) | add / skip | **Skip.** Keeps the campaign to 3 rungs per apply |

## 13. Names and paths

| Thing | Name |
| --- | --- |
| Campaign (parent) id | `typical-scale-v1-YYYYMMDD` (UTC date of the first apply) |
| Apply ids / `test_id` | `typical-scale-{1,2,3}x-r{1,2,3}-YYYYMMDD` (RDS identifier `cwm-bench-typical-scale-3x-r1-YYYYMMDD` is 41 characters, within the 63 limit) |
| Scenario keys | `typical-scale-{1x,2x,3x}-{100,200,300}` |
| Run ids | `typical-scale-<N>x-<RPS>-r<K>` |
| Prereg | `typical/scale-v1/PREREGISTRATION.md` |
| Frozen predictions | `typical/scale-v1/predictions/` |
| Scoring script | `typical/scale-v1/score_scale.py` (imports `score_export.py` rules unchanged) |
| Evidence | `typical/campaign/typical-scale-v1-YYYYMMDD/<apply-id>/` |
| Export | `holdout/exports/typical-scale-v1-YYYYMMDD.summary.md` and `.metrics.csv` |
| Scores | `typical/scores-scale-v1-YYYYMMDD.json` |
| Report | new `typical/REPORT.md` section "App-server count change (typical-scale-v1-YYYYMMDD)" |
| Runbook | `typical/RUNBOOK-CANVASCLOUDAI.md` §11 |
