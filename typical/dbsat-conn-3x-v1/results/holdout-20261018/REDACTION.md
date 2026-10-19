# REDACTION: typical-dbsat-conn-3x-v1-20261018

The public archive is a **redacted derivative** of the private campaign archive, with new hashes. The private original is unchanged and is kept by the maintainer. The method follows `typical/dbsat-pscap-v1/results/holdout-20261017/REDACTION.md` (prereg §7.3).

| | SHA256 |
|---|---|
| Private original, reassembled `typical-dbsat-conn-3x-v1-20261018.tar.gz` (573,779,059 bytes, 24 parts, 182 files) | `faedd42b9964e0de12a62e47ceb68287f5b7891e0877219bb7fc64d12ddbbf9e` |
| Redacted derivative `typical-dbsat-conn-3x-v1-20261018-redacted.tar.gz` (575,407,784 bytes, 182 files) | `74a0beec23271517c68532a736cf07450bba8dcc5dee3dd57d6beab5669772fb` |
| Regenerated file list `FILES.sha256` in the derivative (181 entries; copy in `evidence/archive-FILES.sha256`) | `44ce19db580b1f0153740e6130c383ab6f4aa3ec8346458b73f2514334bcdda4` |
| Regenerated gzip list `RAW-GZIP-VERIFICATION.json` in the derivative (copy in `evidence/`) | `30f894177e875f330e18fa7168f09c1e2338c9eac2b6859c7dc6e03fb89f6c5a` |

The derivative tar is deterministic: names are sorted, owner and group are 0, mtime is fixed, and the gzip carries no name or timestamp. Building it twice gave the same SHA256.

## What was replaced
These are stable pseudonyms that keep the per-node structure.

| Item | Placeholder |
|---|---|
| AWS account ID (also inside ARNs) | `REDACTED` |
| ALB and target-group ARN suffixes | `REDACTED0001`… |
| Internal ALB DNS numbers | `internal-cwm-bench-alb-REDACTED0001.us-east-2.elb.amazonaws.com`… |
| RDS endpoint hash | `<test-id>.REDACTED.us-east-2.rds.amazonaws.com` |
| RDS DbiResourceIds | `db-REDACTED0001`… |
| Public IPv4 (generator) | `192.0.2.1`, `192.0.2.2` (documentation range) |
| EC2 instance IDs, **including in file and directory names** (52 file paths renamed) | `i-REDACTED0001`… |
| EBS volume IDs | `vol-REDACTED0001`… |
| SSM command IDs | `00000000-0000-0000-0000-REDACTED0001`… |
| Runner workspace paths | `<runner-workspace>` |

## What was kept
- The AMI ID, which is pinned in the prereg.
- All SHAs and controller hashes.
- RDS identifiers, which are the test IDs.
- Region names.
- The AMI owner ID in `pinned-ami.json`. It is the public `amazon` AMI owner, not the campaign account.

## Raw k6 files
- The 10 `k6.json.gz` files were scanned after decompression and contained none of the values above.
- Their bytes are unchanged, so their SHA256s match the private original. Only their directory names changed, because the names contain instance IDs.
- They are **not committed** (about 560 MB). They are inside the redacted derivative, which the maintainer keeps off-repo.
- `build_records.py` needs the k6 files. `build_rung_tables.py` needs only the diagnostic time series and breach-monitor rows. `evaluate_conn3x_v1.py` needs the two tables plus `campaign-execution.json` and `RAW-GZIP-VERIFICATION.json`.

## Excluded by the runner (never in either archive)
- Bootstrap and cloud-init files, app stdout and journals.
- Raw SQL and InnoDB snapshots, and raw SSM captures.
- Controller console logs, Terraform state and work directories.
- Git bundles and credentials.

In total, 9,842 files were kept private (`PRIVACY-EXCLUSIONS.json` in the archive).

## Verification
The pattern rescan of the redacted derivative found **0 identifying hits**. It covered file contents, file and directory names, and the decompressed k6 members, and checked:
- account ID and ARNs with an account;
- instance, volume, VPC, subnet, security-group and ENI IDs;
- RDS endpoint hashes and DbiResourceIds;
- SSM UUIDs and AWS access keys;
- secrets, emails and `/home/runner` paths;
- IPv4 addresses outside 192.0.2.0/24.

The only remaining pattern matches are not identifiers:
- 43 twelve-digit runs that are fractional digits of floating-point values;
- the public Amazon AMI owner ID;
- the kept AMI ID;
- the `192.0.2.x` and `REDACTED` placeholders.

Every raw value the redaction replaced was also checked for directly, in all files, path names and decompressed k6 members. None remains.

Running the scripts on the redacted tree produced the same `rung-tables.json` (byte-identical) and the same records as on the private original.
