# Terraform — canonical topology

Flat layout on purpose. There is one topology to audit. Modules would hide instance types.

AWS provider **5.x**. No account IDs are stored in this directory. `terraform validate` does not call AWS. `terraform apply` is out of scope for CI.

## What this applies

| Piece | Pin / default | Notes |
| --- | --- | --- |
| Region | `us-east-1` | A second region is a holdout, not a default change. |
| ALB | application, internal, HTTP:80 | Private-subnet DNS keeps generator traffic VPC-local so source-SG ingress applies. HTTPS:443 only if `acm_certificate_arn` is set. |
| App | **2 × m5.large** | gp2 root, default **30 GiB** (90 baseline IOPS, 3000 burst). |
| Database | **1 × db.r5.large** MySQL **8.0** Single-AZ | gp2 default **100 GiB** (300 baseline IOPS, 3000 burst). |
| Generator | **c6i.xlarge** | 4 vCPU compute-optimized so k6 can drive 1000 RPS. If generator CPU > ~70%, discard the run. |
| OS | Amazon Linux 2023 | AMI from SSM parameter `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64` unless `ami_id` is set. **The SSM value drifts.** Record `resolved_ami_id` in the campaign. |

App nodes sit in public subnets (locked down by SG) so user_data can install Node without a NAT gateway. RDS sits in private subnets with no public access.

## Security groups

- generator → ALB :80 and :443
- ALB → app :8080
- app → RDS :3306

## `max_connections`: cited ~500 vs engine formula

`mysql_max_connections` defaults to **500**. That is a **declared topology choice**:

- Cloud World Model's public accuracy page cites ~500 max connections on db.r5.large and cites AWS RDS MySQL docs for a connection-timeout error at burst. That citation is **not** a company-owned CloudWatch run.
- The RDS MySQL engine default formula is `{DBInstanceClassMemory/12582880}`. On db.r5.large (16 GiB) that evaluates to about **1365**. We have not measured either number on a live instance.
- This parameter group overrides to 500 so `2 × APP_POOL_SIZE=250` can present the cited cap for the pool-bound diagnostic.

Set `mysql_max_connections` if you want a different declared cap. Write the value you applied into the campaign record.

## gp2 burst (third error bucket)

gp2 volumes ≤ 1 TiB burst to **3000 IOPS**. Baseline is `size_GiB * 3`. `BurstBalance` is the remaining burst-credit percent. When it hits **0**, IOPS is capped at baseline.

That condition is the **iops_throttle** bucket. It is distinct from CPU failures and from DB connection failures. Do not fold it into either. The application does not emit this class; derive it from CloudWatch (`AWS/RDS BurstBalance`, `AWS/EBS BurstBalance` on app root volumes).

## AMI pinning

```hcl
# Default: drifting public parameter, resolved at apply time.
data.aws_ssm_parameter.al2023
# Campaign pin:
#   terraform apply -var='ami_id=ami-xxxxxxxx'
```

Copy `resolved_ami_id` and the apply git SHA into `schema/` fields. A coefficients change without a new measurement id is rejected.

## Apply

```bash
cd terraform
terraform init
terraform fmt
terraform validate
terraform plan -var='test_id=YYYYMMDD-campaign' -out=tfplan
# Review. Then, from an account you control:
terraform apply tfplan
```

Required AWS credentials are yours. This repo does not ship them.

After apply, record outputs: `alb_dns`, `alb_arn`, `target_group_arn`, `rds_endpoint`, `generator_ip`, `dashboard_url`, `resolved_ami_id`, instance ids, volume ids. `alb_arn` and `target_group_arn` are additive (same `aws_lb.main` / `aws_lb_target_group.app` addresses) so collect can query AWS/ApplicationELB.

## Variables you will actually set

- `test_id` — campaign slug
- `app_pool_size` — default 250; set **40** for the app-bound diagnostic (re-apply or replace user_data)
- `mysql_max_connections` — default 500
- `extra_tags` — map
- `ami_id` — pin for a campaign
- `app_source_git_ref` — **exact measurement SHA**. user_data fails if this is empty or a branch name (`main` / `master` / `HEAD`). There is no unpinned clone.
- `app_profile` — `lean` (default) copies `app/` and seeds `seed.sql`. `typical` copies `app-typical/` and seeds `seed-typical.sql`.
- `app_workers` — Node worker processes per app server, default `1`, valid `1`..`8`. The typical campaign sets `2`. The primary process does not serve. Each worker's mysql2 `connectionLimit` is `floor(app_pool_size / app_workers)`; `queueLimit` stays `app_queue_limit` on every worker.

With the defaults (`app_profile=lean`, `app_workers=1`) the rendered app user_data matches the lean campaign. A typical campaign is a separate apply: `-var='region=us-east-2' -var='app_profile=typical' -var='app_workers=2'`.

A second-region holdout is a **separate apply** with `-var='region=us-west-2'`. That is not a silent default change and not a rename of the us-east-1 run. The typical-profile counterpart is the same separate apply with `-var='app_profile=typical' -var='app_workers=2'` and scenario keys `typical-second-region` (100 RPS) then `typical-second-region-300` (300 RPS) before destroy. It is not a rename of the us-east-2 typical apply. Other `typical-*` keys, including `typical-holdout-300`, still require us-east-2. See `CLEANUP-COMPAT.md` before touching resource addresses. Use a separate terraform work directory and destroy between applies (`typical/RUNBOOK-CANVASCLOUDAI.md`).

Changing `app_instance_type`, `db_instance_class`, `app_count`, or `region` is a **new topology**. The typical-scale-v1 campaign is that app-count change: nine separate applies with `-var app_count=1`, `2`, or `3`, scenario keys `typical-scale-{1x,2x,3x}-{100,200,300}`, and one pinned `-var ami_id` (`typical/RUNBOOK-CANVASCLOUDAI.md` section 11). The `Topology` tag is `alb-${app_count}x-m5.large-db.r5.large-mysql80-single-az`, which is the previous `alb-2x-…` string when `app_count` is 2.

## Destroy

```bash
terraform destroy -var='test_id=YYYYMMDD-campaign'
```

RDS has `skip_final_snapshot = true` and `deletion_protection = false` so a bench can tear down. `aws_db_instance.main` waits up to **60 minutes** on delete. Destroy order is the instance first, then the DB subnet group, then security groups / VPC. Do not point this at a production account.

RDS-managed ENIs are AWS-managed. Terraform in this repo does **not** call `DetachNetworkInterface` and IAM is **not** broadened for that. If destroy races AWS eventual consistency (subnet group / SG / ENI still in use while RDS is deleting), wait for RDS to release the ENI and retry:

```bash
# From the repo root. Cleanup only — not a campaign result.
./scripts/terraform-destroy-retry.sh -var='test_id=YYYYMMDD-campaign' -auto-approve
```

The script runs `terraform init -reconfigure`, then destroy. On subnet-group / ENI / SG still-in-use failures it refreshes state, waits with bounded backoff, and retries destroy until the instance is gone or the deadline is hit. Success means the stack was destroyed. It does **not** mean a campaign completed.

An interrupted `terraform apply` should default to **cleanup**, not resume measurement. That policy belongs to the Admin Benchmarks worker, not this script.

**Work-directory isolation** is also a worker responsibility. The worker must isolate campaign working directories by claim. This repository does **not** fix the lost-checkout race where a shared campaign directory disappeared mid-apply.
