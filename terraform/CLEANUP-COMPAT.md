# Cleanup compatibility

The Canvas Cloud AI Admin Benchmarks worker has a **fixed cleanup
revision** for already-provisioned campaigns:

```
e95c5319b5c7b9cbd934735241b355df4144cab0
```

That commit must remain publicly fetchable. Do not force-push, rebase,
or rewrite history that would make it unfetchable.

Terraform resource and provider addresses used by that revision must
stay destroy-compatible. Do not rename or replace core resources
(`aws_lb.main`, `aws_instance.app`, `aws_instance.generator`,
`aws_db_instance.main`, and the rest listed in
`scripts/cleanup-compat.json`).

If a future topology change would break destroy of those addresses,
**do not rewrite the old pin**. Document a new pinned cleanup revision
and leave this one fetchable.

Adding files and scripts is fine. Changing `user_data` contents is
fine (instances are replaced on apply; destroy still targets the same
addresses). Additive timeouts on existing resources and
`scripts/terraform-destroy-retry.sh` do not rename addresses.

Destroy order for the RDS path is instance first, then
`aws_db_subnet_group.main`, then security groups / VPC. RDS-managed
ENIs are released by waiting for instance deletion, not by
`DetachNetworkInterface`.
