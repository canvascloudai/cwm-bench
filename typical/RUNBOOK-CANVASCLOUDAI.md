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
- Cost guard set up **before** apply:
  - An AWS Budgets alert on the account at USD 50.
  - A hard wall-clock limit: **destroy no later than 6 hours after `terraform apply` starts, whatever state the campaign is in.**
  - Expected spend [estimate]: about USD 0.63 per hour at list price (ALB 0.0225 + 2 × m5.large 0.096 + db.r5.large 0.24 + c6i.xlarge about 0.17, the last one unverified). That is about 3 to 4.5 hours in total, roughly USD 3 to 5.
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

In `out/00-capability.json`, confirm that `supportedScenarios` contains all five `typical-*` keys (section 5) and record `adapterVersion`.

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
| 5 | `typical-saturation-500` | 500 | holdout (diagnostic) | **optional**: only if keys 1–4 all collected OK and more than 1 hour remains before the 6-hour limit |

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
