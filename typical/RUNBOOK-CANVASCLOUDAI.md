# Runbook for CanvasCloudAI: cwm-bench "typical" campaign (typical-v1)

Audience: the CanvasCloudAI campaign runner. It explains what cwm-bench is, then gives the exact steps.
Frozen workload definition: `typical/PREREGISTRATION.md` in the repo. Read sections 2, 6 and 10 of it before starting.

Placeholders you must fill in:
- `<SHA>`: the exact cwm-bench commit Kevin gives you. It must contain `typical/PREREGISTRATION.md`. A branch name is not accepted, and the app refuses to boot from one.
- `<CAMPAIGN>`: a campaign slug, for example `typical-v1-20261001`.

## 1. What cwm-bench is (short)

- `terraform/` builds one fixed AWS stack:
  - an internal ALB
  - 2 × m5.large app servers
  - a db.r5.large MySQL 8.0 database
  - a c6i.xlarge load generator running k6

  Every resource is tagged `Project=cwm-bench` and `TestId=<CAMPAIGN>`.
- At boot, each app server downloads cwm-bench at `<SHA>`, seeds MySQL, and starts the app. With `app_profile=typical` and `app_workers=2` it runs the RealWorld-style typical workload in 2 Node worker processes.
- `scripts/worker-adapter.mjs` is the only interface you drive. It has three commands, and each prints one JSON object on stdout:
  - `wait-ready`: checks the stack is healthy and that every app server reports the expected profile.
  - `run --scenario <key>`: starts k6 on the generator through AWS SSM and waits for it to finish. That takes about 20 minutes (5 min warmup plus 15 min steady).
  - `collect --scenario <key>`: pulls CloudWatch and the k6 summary into one run document.
- Nothing is invented. Missing data stays `null`, and an incomplete required collect fails.

## 2. Prerequisites

- An AWS account Kevin controls, with credentials allowed to create and destroy EC2, VPC, ELBv2, RDS, IAM roles and instance profiles, SSM parameters and CloudWatch dashboards. Also read access to CloudWatch metrics, and SSM `SendCommand`.
- **Region: us-east-2.** Set it everywhere (section 3).
- Tools: Terraform 1.9.8 (pinned in `terraform/.terraform-version`), Node 20, git, AWS CLI v2.
- Cost guard:
  - No budget alert and no time limit. Take as long as the runs need.
  - Expected spend [estimate]: about USD 0.63 per hour while the stack is up at list price (ALB 0.0225 + 2 × m5.large 0.096 + db.r5.large 0.24 + c6i.xlarge about 0.17, the last one unverified).
  - Tear down as soon as the last run is collected or the campaign stops for any reason. Do not leave the stack up between sessions.
- One isolated working directory per campaign. Do not share it with any other campaign (terraform/README.md, "work-directory isolation").

## 3. Setup

```bash
git clone https://github.com/canvascloudai/cwm-bench.git cwm-bench-<CAMPAIGN>
cd cwm-bench-<CAMPAIGN>
git checkout --detach <SHA>
test -f typical/PREREGISTRATION.md
mkdir -p out

export AWS_REGION=us-east-2
export AWS_DEFAULT_REGION=us-east-2
export CWM_CAMPAIGN_ID=<CAMPAIGN>
unset CWM_RUN_ID CWM_WARMUP CWM_DURATION   # use the defaults: 5m warmup, 15m steady

# Local sanity check (no AWS calls)
(cd app-typical && npm ci --omit=dev --ignore-scripts && npm run check)
node scripts/worker-adapter.mjs wait-ready --json > out/00-capability.json
```

In `out/00-capability.json`, confirm that `supportedScenarios` contains the five `typical-*` keys in section 5, the four holdout keys in section 10, the nine `typical-scale-*` keys in section 11, and the nine `typical-p95-*` keys in section 12. Record `adapterVersion` (`1.6.0` on this revision). The recorded `typical-v1-20260927c` campaign remains adapter `1.3.0`. The recorded holdouts remain adapter `1.4.0`. The recorded scale-v1 campaign remains adapter `1.5.0`.

## 4. Provision (typical profile, us-east-2)

```bash
cd terraform
terraform init
terraform plan \
  -var='region=us-east-2' \
  -var='test_id=<CAMPAIGN>' \
  -var='app_profile=typical' \
  -var='app_workers=2' \
  -var='app_source_git_ref=<SHA>' \
  -out=tfplan
terraform apply tfplan
terraform output -json > ../out/01-terraform-outputs.json
cd ..
date -u +%Y-%m-%dT%H:%M:%SZ > out/01-apply-finished-utc.txt
```

- Do not change any other variable. Instance types, count, pool size and `max_connections` are all part of the frozen topology.
- Record `resolved_ami_id` from the outputs.

## 5. Readiness

```bash
node scripts/worker-adapter.mjs wait-ready --json > out/02-wait-ready.json
```

Continue only if all of these hold:
- `ok` is true.
- `appNodes` has one entry per app server. Each entry's `profile` is `"typical"`, `workers` is 2, and `gitSha` equals `<SHA>`.

Readiness retries normal bootstrap for up to 20 minutes. The typical seed is larger than lean's, so a long boot is normal. If readiness fails, go to section 8 (teardown). Do not start a run.

## 6. Runs: exact order

Run these in this order, one at a time, all in the same apply:

| # | Scenario key | Total RPS | Split | Required |
| ---: | --- | ---: | --- | --- |
| 1 | `typical-fit-20` | 20 | fit | yes |
| 2 | `typical-fit-100` | 100 | fit | yes |
| 3 | `typical-fit-200` | 200 | fit | yes |
| 4 | `typical-holdout-300` | 300 | holdout | yes |
| 5 | `typical-saturation-500` | 500 | holdout (diagnostic) | **optional**: only if keys 1-4 all collected OK |

For each key:

```bash
KEY=typical-fit-20   # then typical-fit-100, typical-fit-200, typical-holdout-300, [typical-saturation-500]
node scripts/worker-adapter.mjs run --scenario "$KEY" --json > "out/10-$KEY.run.json"
node scripts/worker-adapter.mjs collect --scenario "$KEY" --json > "out/11-$KEY.collect.json"
```

Check after each key:
- **`run` must have `ok: true`.** If it fails with an SSM or transport error, stop any detached k6:
  ```bash
  CWM_RUN_ID=<runId from the run JSON> node scripts/worker-adapter.mjs teardown --json
  ```
  Then retry the same key **once**. Keep both JSON files; never overwrite them (add `-attempt2` to the file name).
- **`collect` must have `ok: true`.** If a required rung returns `COLLECT_INCOMPLETE`, wait 5 minutes for CloudWatch to catch up and run `collect` once more. If it is still incomplete, record that and move on.
- **Generator CPU in the steady window must not exceed 70%.** If it does, the run is discarded: re-run that key once and keep both results.
- Do not change warmup, duration, RPS or any variable between runs. Do not re-seed.
- A failed or error-heavy run is still a result. Hand it back; do not hide it (PREREGISTRATION section 10).
- `PROFILE_MISMATCH` or `TYPICAL_REGION_CONSTRAINT` means this apply is not `app_profile=typical`, `app_workers=2`, region `us-east-2`. Fix the apply. Do not switch scenario keys to get past it.

## 7. Where results land

- **Structured results:** the `collect` JSON files you saved in `out/`. These are the files to hand back.
- **Raw k6 artifacts** on the generator, at `/opt/cwm-bench/results/raw/<CAMPAIGN>/<runId>/` (`summary.json`, `k6.json`, `runner.log`, `exit.code`). They are destroyed with the stack. Optional: before teardown, copy each `summary.json` into `out/raw/<runId>/` through SSM.
- Nothing is written into the repo's `results/` directory. CI rejects measured run JSON there on purpose.

## 8. Teardown (always, including after any failure)

```bash
cd terraform
terraform destroy \
  -var='region=us-east-2' -var='test_id=<CAMPAIGN>' \
  -var='app_profile=typical' -var='app_workers=2' \
  -var='app_source_git_ref=<SHA>' -auto-approve \
  || ../scripts/terraform-destroy-retry.sh \
       -var='region=us-east-2' -var='test_id=<CAMPAIGN>' \
       -var='app_profile=typical' -var='app_workers=2' \
       -var='app_source_git_ref=<SHA>' -auto-approve
cd ..
```

- RDS deletion can take up to 60 minutes.
- The retry script handles subnet-group, ENI and security-group eventual-consistency races (terraform/README.md). It is cleanup only; succeeding does not mean the campaign succeeded.

Verify that nothing is left, and save the evidence:

```bash
aws resourcegroupstaggingapi get-resources --region us-east-2 \
  --tag-filters Key=TestId,Values=<CAMPAIGN> --output json > out/90-leftover-tagged.json
aws rds describe-db-instances --region us-east-2 \
  --query "DBInstances[?contains(DBInstanceIdentifier, 'cwm-bench')].[DBInstanceIdentifier,DBInstanceStatus]" \
  --output json > out/91-leftover-rds.json
aws ec2 describe-instances --region us-east-2 \
  --filters Name=tag:TestId,Values=<CAMPAIGN> Name=instance-state-name,Values=pending,running,stopping,stopped \
  --output json > out/92-leftover-ec2.json
date -u +%Y-%m-%dT%H:%M:%SZ > out/93-destroy-finished-utc.txt
```

The tagging API can briefly list resources that have just been deleted. Re-check after 15 minutes if anything appears. If real resources remain after that, report them to Kevin by ID. Do not delete anything by hand outside Terraform unless Kevin says so.

## 9. What to hand back to Kevin

Send one archive of `out/`, plus a short note. The archive contains:
- `00-capability.json`, `01-terraform-outputs.json`, `01-apply-finished-utc.txt`, `02-wait-ready.json`
- For every attempt of every key: `10-<key>.run.json` and `11-<key>.collect.json`, including failed or discarded attempts
- Optional `raw/<runId>/summary.json`
- `90`–`93` teardown evidence

The note states:
1. `<SHA>`, `<CAMPAIGN>`, region, `resolved_ami_id`, `adapterVersion`
2. Apply start and end, and destroy end, in UTC
3. Every attempt in order, with `ok` and any error code; which runs were discarded and why
4. Generator CPU peak per run
5. Whether the optional 500 RPS rung was run
6. Confirmation that no tagged resources remain (or the IDs of any that do)

Do not summarize or interpret the metrics. Kevin publishes them against the pre-registered analysis plan.

## 10. Day and region holdouts (separate from the typical-v1 ladder)

These keys are not part of section 6. There are two applies, each with its own terraform working directory and campaign slug. On each apply, run the 100 RPS key and then the 300 RPS key before destroy. Destroy the stack between the two applies. Do not run them inside the typical-v1 apply, and do not change instance types, pool size, workers, the request mix, warmup, or duration. Analysis is `typical/PREREGISTRATION.md` section 12. Parent id for the pair: `typical-holdouts-v1-YYYYMMDD`.

The later-day fit date is the typical-v1 fit UTC date **2026-09-27** (`typical-v1-20260927c`). The UTC day of that apply must be later. Both keys on that apply use the same date.

One attempt per key. Rerun only if generator CPU in the steady window exceeds about 70%, or for a documented infrastructure failure. Keep every attempt (add `-attempt2` to the file name; do not overwrite).

### 10.1 Later day (us-east-2): `typical-later-day` then `typical-later-day-300`

```bash
git clone https://github.com/canvascloudai/cwm-bench.git cwm-bench-typical-later-day-YYYYMMDD
cd cwm-bench-typical-later-day-YYYYMMDD
git checkout --detach <SHA>
mkdir -p out

export AWS_REGION=us-east-2
export AWS_DEFAULT_REGION=us-east-2
export CWM_CAMPAIGN_ID=typical-later-day-YYYYMMDD
export CWM_FIT_CAMPAIGN_DATE=2026-09-27
unset CWM_RUN_ID CWM_WARMUP CWM_DURATION

cd terraform
terraform init
terraform apply \
  -var='region=us-east-2' \
  -var='test_id=typical-later-day-YYYYMMDD' \
  -var='app_profile=typical' \
  -var='app_workers=2' \
  -var='app_source_git_ref=<SHA>'
cd ..

node scripts/worker-adapter.mjs wait-ready --json > out/02-wait-ready.json
node scripts/worker-adapter.mjs run --scenario typical-later-day --json > out/10-typical-later-day.run.json
node scripts/worker-adapter.mjs collect --scenario typical-later-day --json > out/11-typical-later-day.collect.json
node scripts/worker-adapter.mjs run --scenario typical-later-day-300 --json > out/10-typical-later-day-300.run.json
node scripts/worker-adapter.mjs collect --scenario typical-later-day-300 --json > out/11-typical-later-day-300.collect.json
```

Destroy this work directory with section 8 (`region=us-east-2`, `test_id=typical-later-day-YYYYMMDD`) only after both keys are collected, and before starting the other apply.

`LATER_DAY_CONSTRAINT` means the UTC day is not after 2026-09-27, or `CWM_FIT_CAMPAIGN_DATE` was not set. Do not switch the key to `typical-fit-100` or `typical-holdout-300` to get past it. `TYPICAL_REGION_CONSTRAINT` means this apply is not us-east-2.

### 10.2 Second region (us-west-2): `typical-second-region` then `typical-second-region-300`

Use a new clone or a fresh terraform directory. Do not reuse the us-east-2 state.

```bash
git clone https://github.com/canvascloudai/cwm-bench.git cwm-bench-typical-second-region-YYYYMMDD
cd cwm-bench-typical-second-region-YYYYMMDD
git checkout --detach <SHA>
mkdir -p out

export AWS_REGION=us-west-2
export AWS_DEFAULT_REGION=us-west-2
export CWM_CAMPAIGN_ID=typical-second-region-YYYYMMDD
unset CWM_RUN_ID CWM_WARMUP CWM_DURATION CWM_FIT_CAMPAIGN_DATE

cd terraform
terraform init
terraform apply \
  -var='region=us-west-2' \
  -var='test_id=typical-second-region-YYYYMMDD' \
  -var='app_profile=typical' \
  -var='app_workers=2' \
  -var='app_source_git_ref=<SHA>'
cd ..

node scripts/worker-adapter.mjs wait-ready --json > out/02-wait-ready.json
node scripts/worker-adapter.mjs run --scenario typical-second-region --json > out/10-typical-second-region.run.json
node scripts/worker-adapter.mjs collect --scenario typical-second-region --json > out/11-typical-second-region.collect.json
node scripts/worker-adapter.mjs run --scenario typical-second-region-300 --json > out/10-typical-second-region-300.run.json
node scripts/worker-adapter.mjs collect --scenario typical-second-region-300 --json > out/11-typical-second-region-300.collect.json
```

Destroy with section 8, substituting `region=us-west-2` and `test_id=typical-second-region-YYYYMMDD` in the terraform vars and in the leftover AWS checks, only after both keys are collected.

`SECOND_REGION_CONSTRAINT` means this apply is not us-west-2. Other typical keys in us-west-2, including `typical-fit-100` and `typical-holdout-300`, fail with `TYPICAL_REGION_CONSTRAINT`. Do not point those keys at us-west-2.

## 11. App-server count change (typical-scale-v1)

These nine applies are not part of section 6 or section 10. The frozen plan is `typical/scale-v1/PREREGISTRATION.md`. Predictions are already frozen in `typical/scale-v1/predictions/predictions.json` (engine 1.2.14). Do not re-query the live engine to score them. Do not change instance types, pool size, workers, the request mix, warmup, or duration. The only topology variable is `app_count`.

`<SHA>` is the commit that contains `typical/scale-v1/PREREGISTRATION.md`. `<AMI>` is one id for all nine applies. Resolve it once before session 1:

```bash
aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --region us-east-2 \
  --query Parameter.Value --output text
```

Pass that same `-var ami_id=<AMI>` on every apply. Record it in the campaign note. This runbook does not name an AMI, because the wiring commit did not query AWS.

### 11.1 Session order (Latin square)

Three sessions. Each session is one repetition of each app count. Each count takes each position once. Sessions may fall on different UTC days.

| Session | 1st apply | 2nd apply | 3rd apply |
| --- | --- | --- | --- |
| S1 (rep 1) | 2× | 1× | 3× |
| S2 (rep 2) | 1× | 3× | 2× |
| S3 (rep 3) | 3× | 2× | 1× |

Apply id: `typical-scale-${N}x-r${K}-YYYYMMDD`, where `K` is the repetition (1, 2, or 3) and `YYYYMMDD` is the UTC date of that apply. Parent id: `typical-scale-v1-YYYYMMDD` using the UTC date of the first apply. Each apply is a fresh clone and a fresh terraform state. Destroy before the next apply.

On every apply the ladder is 100, then 200, then 300, on that same stack.

### 11.2 One apply

```bash
APPLY=typical-scale-${N}x-r${K}-YYYYMMDD
git clone https://github.com/canvascloudai/cwm-bench.git cwm-bench-$APPLY && cd cwm-bench-$APPLY
git checkout --detach <SHA> && test -f typical/scale-v1/PREREGISTRATION.md && mkdir -p out
export AWS_REGION=us-east-2 AWS_DEFAULT_REGION=us-east-2 CWM_CAMPAIGN_ID=$APPLY
unset CWM_WARMUP CWM_DURATION CWM_FIT_CAMPAIGN_DATE
node scripts/worker-adapter.mjs wait-ready --json > out/00-capability.json
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
  # Set CWM_RUN_STARTED_AT and CWM_RUN_ENDED_AT from the generator started_at / completed_at
  # before collect. Unset, collect falls back to a trailing 40-minute window and will
  # include the previous rung.
  node scripts/worker-adapter.mjs collect --scenario $KEY --json > out/11-$KEY.collect.json
done
```

Do not change any other variable: instance types, `app_pool_size`, `mysql_max_connections`, `name_prefix`, warmup, duration.

Gates (stop or record):

- After apply: `topology_declaration.app_count` is N, `app_instance_ids` has length N, `resolved_ami_id` is `<AMI>`, and `ami_source` is `variable`.
- After wait-ready: `ok`, adapterVersion `1.5.0`, and N `appNodes`, each `typical` / 2 workers / `<SHA>`.
- After each run: `ok: true` and `adapterVersion` `1.5.0`.
- After each collect: `ok`, `complete`, `identityMatches`, `invented: false`, generator CPU in the steady window at or below 70%, and `terraformOutputs.topology_declaration.app_count` is N. The collect window must cover only that rung. `collectionWindow()` falls back to a trailing 40-minute window when `CWM_RUN_STARTED_AT` / `CWM_RUN_ENDED_AT` are unset. Started back-to-back, that window would span the previous rung. Check `cloudwatch.window.source` is `persisted-run`, or that the window bounds match the run.
- `APP_COUNT_MISMATCH` means the live app count is not the key's count. Do not switch to another typical key to get past it. Existing typical keys, including `typical-holdout-300`, also expect 2 app servers.

Re-run rules are `typical/scale-v1/PREREGISTRATION.md` §8.2. Errors, saturation, and slow rungs are never re-run. Keep every attempt (`-attempt2`).

### 11.3 Destroy and the cleanup lock

Destroy with section 8, using `region=us-east-2`, `test_id=$APPLY`, and the same `-var` set (`app_count`, `ami_id`, `app_profile`, `app_workers`, `app_source_git_ref`).

The holdouts ended with the runner's strict safety lock retained: tag inventory still listed resources that direct checks then classified as terminated or not-found (`typical/campaign/typical-holdouts-v1-20261006/README-execution.md`). Between these nine applies, do the section 8 leftover checks (EC2 non-terminated, RDS, volumes, security-group rules). Proceed when every ARN classifies as terminated or not-found, and record that classification on the apply. Do not wait for an empty tag inventory, and do not delete anything by hand outside Terraform.

## 12. P95 model validation (typical-p95-v1)

These nine applies are not part of section 6, section 10, or section 11. The frozen plan is `typical/p95-v1/PREREGISTRATION.md`. The candidate predictions are frozen in `typical/p95-v1/predictions/model-predictions.csv`. Do not recompute them and do not query a live engine to score them. The engine baseline is `typical/p95-v1/predictions/engine-baseline/`. Leave that directory empty until the MCP freeze writes the 9 cells (same graphs as `typical/scale-v1/predictions/create-payload-<N>x-<RPS>.json` at the matching N and RPS) and the `engineVersion` that freeze returns. The commit that contains the filled baseline is `<SHA>` / `measurement_sha`. Do not apply before that commit exists. Do not change instance types, pool size, workers, the request mix, warmup, or duration.

`<AMI>` is one id for all nine applies. Resolve it once before session 1 and record it in the campaign note. This runbook does not name an AMI, because the wiring commit did not query AWS.

```bash
aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --region us-east-2 \
  --query Parameter.Value --output text
```

Pass that same `-var ami_id=<AMI>` on every apply.

### 12.1 Session order (Latin square, 3 UTC days)

Each config runs once per day and once in each daily slot. A replacement apply goes at the end of the same day if time allows, otherwise first on the next day. A fourth UTC day is only for replacements.

| Slot | Day A | Day B | Day C |
| --- | --- | --- | --- |
| 1 | 1×-r1 | 2×-r2 | 3×-r3 |
| 2 | 2×-r1 | 3×-r2 | 1×-r3 |
| 3 | 3×-r1 | 1×-r2 | 2×-r3 |

Apply id / `test_id`: `typical-p95-${N}x-r${K}-YYYYMMDD`, where `K` is 1, 2, or 3 and `YYYYMMDD` is the UTC date of that apply. A replacement adds one letter (`r1a`). Parent id: `typical-p95-v1-YYYYMMDD` using the UTC date of the first apply. Each apply is a fresh clone, a fresh terraform state, and the standard seed. Destroy before the next apply.

On every apply the ladder is 300, then 200, then 100, on that same fresh stack. Do not set `CWM_LADDER` to any other order.

### 12.2 One apply

```bash
APPLY=typical-p95-${N}x-r${K}-YYYYMMDD
git clone https://github.com/canvascloudai/cwm-bench.git cwm-bench-$APPLY && cd cwm-bench-$APPLY
git checkout --detach <SHA> && test -f typical/p95-v1/PREREGISTRATION.md && test -f typical/p95-v1/predictions/engine-baseline/engine-version.txt && mkdir -p out
export AWS_REGION=us-east-2 AWS_DEFAULT_REGION=us-east-2 CWM_CAMPAIGN_ID=$APPLY CWM_MEASUREMENT_SHA=<SHA>
unset CWM_WARMUP CWM_DURATION CWM_FIT_CAMPAIGN_DATE CWM_LADDER
node scripts/worker-adapter.mjs wait-ready --json > out/00-capability.json
cd terraform && terraform init && terraform apply \
  -var='region=us-east-2' -var="test_id=$APPLY" -var='app_profile=typical' -var='app_workers=2' \
  -var="app_count=$N" -var="ami_id=<AMI>" -var='app_source_git_ref=<SHA>'
terraform output -json > ../out/01-terraform-outputs.json && cd ..
node scripts/worker-adapter.mjs wait-ready --json > out/02-wait-ready.json
aws rds describe-db-instances --region us-east-2 \
  --query "DBInstances[?contains(DBInstanceIdentifier,'cwm-bench')].{id:DBInstanceIdentifier,version:EngineVersion}" \
  > out/03-rds-engine-version.json
for RPS in 300 200 100; do
  KEY=typical-p95-${N}x-$RPS
  export CWM_SCENARIO=$KEY CWM_RUN_ID=$KEY-r$K
  node scripts/worker-adapter.mjs run --scenario $KEY --json > out/10-$KEY.run.json
  # Set CWM_RUN_STARTED_AT and CWM_RUN_ENDED_AT from the generator started_at / completed_at
  # before collect. Unset, collect falls back to a trailing 40-minute window.
  node scripts/worker-adapter.mjs collect --scenario $KEY --json > out/11-$KEY.collect.json
done
```

Record the RDS `EngineVersion` string from `out/03-rds-engine-version.json` on the apply. A version change mid-campaign is a confound, not an invalidation.

Do not change any other variable: instance types, `app_pool_size`, `mysql_max_connections`, `name_prefix`, warmup, or duration. Do not add a k6 threshold. The runner gzips `k6.json` to `k6.json.gz` next to `summary.json`. Event-loop lag and mysql2 pool-wait log lines are not instrumented.

Gates, checked before the next rung where the collect is in hand (`typical/p95-v1/score_p95_v1.py` implements the same rules):

- After apply: `topology_declaration.app_count` is N, `app_instance_ids` has length N, `resolved_ami_id` is `<AMI>`, and `ami_source` is `variable`.
- After wait-ready: `ok`, adapterVersion `1.6.0`, and N `appNodes`, each `typical` / 2 workers / `<SHA>`.
- After each run: `ok: true`, `adapterVersion` `1.6.0`, `ladder` `[300,200,100]`, and `rung_pos` 1 then 2 then 3. `ladder_history` is the rungs completed on this apply.
- After each collect: `ok`, `identityMatches`, `invented: false`, `latency.untaggedAggregate` true, and `latency.p95Ms` equal to the untagged `http_req_duration` aggregate. `artifacts.requestLevelRaw.present` is true (`k6.json.gz`). `cloudwatch.window.source` is `persisted-run` and the window covers only that rung. `terraformOutputs.topology_declaration.app_count` is N.
- Generator: CPU mean over the steady window at or below 70%, and `dropped_iterations` at or below 0.5% of scheduled iterations (target RPS × 1,050). If generator CPU is still missing after the CloudWatch re-collects below, the rung passes this check only when dropped iterations are within that limit and peak VUs stayed under the pre-allocated VU budget.
- `APP_COUNT_MISMATCH` means the live app count is not the key's count. Do not switch to a fit, holdout, or scale key. `REUSED_KEY` means this test id was pointed at one of those keys. `LADDER_ORDER` means the rung is not the next step of 300 → 200 → 100. `TEST_ID_MISMATCH` means the apply id does not match `typical-p95-{1x|2x|3x}-r{1..3}-YYYYMMDD`.

### 12.3 Invalidation and pause

Re-run rules are `typical/p95-v1/PREREGISTRATION.md` §7.7. Rungs inside an apply are never re-run. A failed generator check, identity mismatch, missing k6 summary, or incomplete ladder replaces the whole apply (letter suffix). CloudWatch gaps are re-collected up to twice with explicit `CWM_RUN_STARTED_AT` / `CWM_RUN_ENDED_AT`; the k6 summary stays. A steady `http_req_duration` sub-metric, or `latency.p95Ms` that is not the untagged aggregate, invalidates the apply and pauses the campaign. Missing `k6.json.gz` in two or more applies pauses the campaign. At most 6 replacement applies, and a soft cap of $40 total AWS spend. If a seventh replacement would be needed or the next apply would pass $40: pause, destroy any live stack, and ask Kevin whether to raise the budget or stop. The result is `PARTIAL: budget exhausted` only if he stops. Applies on different SHAs are never pooled. Score with `python3 typical/p95-v1/score_p95_v1.py` against the frozen CSV and the frozen engine file. Do not query the live engine.

### 12.4 Destroy

Destroy with section 8, using `region=us-east-2`, `test_id=$APPLY`, and the same `-var` set (`app_count`, `ami_id`, `app_profile`, `app_workers`, `app_source_git_ref`). Run the section 8 leftover checks immediately and again after 15 minutes. Proceed when every ARN classifies as terminated or not-found. Do not delete anything by hand outside Terraform.
