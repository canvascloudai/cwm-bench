# Terraform — canonical topology

Flat layout on purpose. There is one topology to audit. Modules would hide instance types.

AWS provider **5.x**. No account IDs are stored in this directory. `terraform validate` does not call AWS. `terraform apply` is out of scope for CI.

## What this applies

| Piece | Pin / default | Notes |
| --- | --- | --- |
| Region | `us-east-1` | A second region is a holdout, not a default change. |
| ALB | application, internet-facing, HTTP:80 | HTTPS:443 only if `acm_certificate_arn` is set. |
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

After apply, record outputs: `alb_dns`, `rds_endpoint`, `generator_ip`, `dashboard_url`, `resolved_ami_id`, instance ids, volume ids.

## Variables you will actually set

- `test_id` — campaign slug
- `app_pool_size` — default 250; set **40** for the app-bound diagnostic (re-apply or replace user_data)
- `mysql_max_connections` — default 500
- `extra_tags` — map
- `ami_id` — pin for a campaign
- `app_source_git_ref` — **exact measurement SHA**. user_data fails if this is empty or a branch name (`main` / `master` / `HEAD`). There is no unpinned clone.

A second-region holdout is a **separate apply** with `-var='region=us-west-2'`. That is not a silent default change and not a rename of the us-east-1 run. See `CLEANUP-COMPAT.md` before touching resource addresses.

Changing `app_instance_type`, `db_instance_class`, `app_count`, or `region` is a **new topology**.

## Destroy

```bash
terraform destroy -var='test_id=YYYYMMDD-campaign'
```

RDS has `skip_final_snapshot = true` so a bench does not leave snapshots behind. Do not point this at a production account.
