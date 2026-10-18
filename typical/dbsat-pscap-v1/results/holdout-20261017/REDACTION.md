# REDACTION: typical-dbsat-pscap-v1-20261017

The public archive is a **redacted derivative** of the private campaign archive. It has new hashes. The private original is unchanged and is kept by the maintainer.

| | SHA256 |
|---|---|
| Private original, reassembled `typical-dbsat-pscap-v1-20261017.tar.gz` (577,021,826 bytes, 25 parts) | `06787143a17241d087a6fd8b57e0ee42f722ef6fc2b9d2aa6dc0e87420ea3daa` |
| Redacted derivative `typical-dbsat-pscap-v1-20261017-redacted.tar.gz` (577,829,620 bytes, 218 files) | `2a82550f5eaecb92fb57af9c1701659c056aa413932e78105578677b4f1fa2ea` |
| Regenerated file list `FILES.sha256` in the derivative (217 entries; copy in `evidence/archive-FILES.sha256`) | `87feb406f86cfb90c694e667b02eecb7c51fddf68b3e46ecee0469e5f58b7df0` |
| Regenerated gzip list `RAW-GZIP-VERIFICATION.json` in the derivative (copy in `evidence/`) | `9d98665ad773d72b525cd6e75adedc5034137ffd516013e2ba386ff43e38abad` |

The derivative tar is deterministic: names are sorted, owner and group are 0, mtime is fixed, and the gzip carries no name or timestamp.

## What was replaced
This follows the `typical-p95-v1-20261010` convention: stable pseudonyms that keep the per-node structure.

| Item | Placeholder |
|---|---|
| AWS account ID (also inside ARNs) | `REDACTED` |
| ALB and target-group ARN suffixes | `REDACTED0001`… |
| Internal ALB DNS numbers | `internal-cwm-bench-alb-REDACTED0001.us-east-2.elb.amazonaws.com`… |
| RDS endpoint hash | `<test-id>.REDACTED.us-east-2.rds.amazonaws.com` |
| RDS DbiResourceIds | `db-REDACTED0001`… |
| Public IPv4 (generator) | `192.0.2.1`, `192.0.2.2` (documentation range) |
| EC2 instance IDs, **including in file and directory names** (54 paths renamed) | `i-REDACTED0001`… |
| EBS volume IDs | `vol-REDACTED0001`… |
| SSM command IDs | `00000000-0000-0000-0000-REDACTED0001`… |
| Runner workspace paths | `<runner-workspace>` |

## What was kept
- The AMI ID (pinned in the prereg).
- All SHAs and controller hashes.
- RDS identifiers, which are the test IDs.
- Region names and the CloudWatch dashboard name.
- The AMI owner ID in `pinned-ami.json`. It is the public `amazon` AMI owner, not the campaign account.

## Raw k6 files
- The 10 `k6.json.gz` files were scanned after decompression and contained none of the values above. Their bytes are unchanged, so their SHA256s match the private original. Only their directory names changed (instance IDs).
- They are **not committed** (about 560 MB), following `discovery-20261016` and `typical-p95-v1-20261010`. They are inside the redacted derivative, which the maintainer keeps off-repo.
- Each `download-verification.json` still records the original transfer hash.
- `build_records.py` needs the k6 files. `build_rung_tables.py` and `evaluate_pscap_v1.py` need only the diagnostic time series, which is also in the derivative.

## Excluded by the runner (never in either archive)
- Bootstrap and cloud-init files, app stdout and journals.
- Raw SQL and InnoDB snapshots, and raw SSM captures.
- Controller console logs, Terraform state and work directories.
- Git bundles and credentials.

In total, 9,332 files were kept private (`PRIVACY-EXCLUSIONS.json`).

## Verification
- **Pattern rescan of the redacted derivative found 0 hits** for every pattern:
  - account ID and ARNs with an account;
  - instance, volume, VPC, subnet, security-group and ENI IDs;
  - RDS endpoint hashes and DbiResourceIds;
  - SSM UUIDs and AWS access keys;
  - secrets, emails and `/home/runner` paths;
  - IPv4 addresses outside 192.0.2.0/24.

  The scan covered file and path names and the decompressed k6 members. It also checked for every raw value the redaction replaced, and found none.
- All JSON parses, and `FILES.sha256` verifies.
- `build_records.py` on the redacted tree gives records identical to those from the private original. So do `build_rung_tables.py` and `evaluate_pscap_v1.py`.
- The redaction tool and its ID mapping hold raw values. They are kept off-repo and not published.
