# Terraform — GCP fit topology

Separate from `terraform/`. The AWS module is not modified. `terraform validate` does not call Google. `terraform apply` is out of scope for CI.

Project id, region, and credentials come only from variables. This directory commits no project id, project number, service-account email, billing account, or image id.

## What this applies

| Piece | Pin / default | Notes |
| --- | --- | --- |
| Region | `us-central1` | Generator zone `us-central1-a`. |
| Load balancer | External HTTP(S), HTTP:80 | `EXTERNAL_MANAGED`. HTTPS only if `https_certificate` is set. No certificate is committed. |
| App | **2 × n2-standard-2** | Regional managed instance group. pd-balanced boot disk, 30 GiB. |
| Database | **db-custom-2-16384** MySQL **8.0** zonal | 2 vCPU, 16384 MB. Private IP. PD_SSD 100 GiB. No BurstBalance metric. |
| Generator | **c2-standard-4** | In-region. Stand-in for c6i.xlarge; not measured against it. |
| Image | `app_image` (required) | No family lookup. The same pin boots the app and the generator. |

Startup for the app follows `terraform/userdata/app.sh.tftpl`: Node 20, pinned SHA, `app-typical/` and `seed-typical.sql` when `app_profile=typical` (the default here), same pool and systemd unit. The password is read from Secret Manager instead of SSM. The image must provide `dnf` and `systemd`, because that script is the Amazon Linux boot path.

## Flags

`mysql_max_connections` defaults to **500**. `mysql_max_prepared_stmt_count` defaults to **16382**, and at that default the flag is not sent. Both are outputs. Offline check: `terraform -chdir=terraform/gcp test`.

## Apply

```bash
cd terraform/gcp
terraform init
terraform fmt
terraform validate
terraform plan \
  -var='project_id=YOUR_PROJECT_ID' \
  -var='app_image=YOUR_PINNED_IMAGE' \
  -var='test_id=gcp-fit-v1-r1-YYYYMMDD' \
  -var='app_source_git_ref=YOUR_SHA' \
  -out=tfplan
```

Do not commit the plan, the state, or a credentials file.

## Destroy

`deletion_protection` is false and backups are off so a bench can tear down. Cloud SQL delete waits up to 60 minutes. This is cleanup, not a campaign result.
