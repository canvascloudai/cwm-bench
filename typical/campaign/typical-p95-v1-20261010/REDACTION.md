# REDACTION: typical-p95-v1-20261010
Stricter than scale-v1: the AWS account id and IAM user/ARN/unique ids are replaced with REDACTED. Public and private IPv4s become stable pseudonyms in 192.0.2.x. EC2/VPC resource ids become stable pseudonyms of the form `<type>-REDACTEDnnnn`, which keeps the per-node structure. RDS DbiResourceIds, KMS key ids, ALB/target-group ARN suffixes, ALB DNS numbers and the RDS endpoint hash are also replaced.
Kept: AMI, SHAs, RDS identifiers (which are the test ids), VPC CIDRs, 127.0.0.1 and 0.0.0.0. k6.json.gz members were scanned after decompression.
Original archive sha256: 56f34f91853dd76bf28e836f7e54ff0c8d76157b424a24f17326eb630d6c8fac
Redacted tar.gz sha256: 3b7a096a74077168a5971b9987f064a1804f7c49b3933d4b8eabfad336d75c94
Verification: the scan for the account id, IAM user, AIDA ids, i/vol/sg/vpc/subnet ids, db- resource ids and the endpoint hash found 0 hits. The remaining IPs are only the kept CIDRs/loopback and 203.0.113.10 (documentation range). All JSON still parses. score_p95_v1.py on the redacted tree gives identical groups/verdicts.
The redaction tool and its ID mapping hold raw values. They are kept off-repo and not published.

## Not in git: request-level k6 files
The 27 per-rung `rungs/*/k6.json.gz` files are excluded. Redacted, they total about 723 MB as `typical-p95-v1-redacted.tar.gz` (sha256 `3b7a096a74077168a5971b9987f064a1804f7c49b3933d4b8eabfad336d75c94`). That tarball is kept off-repo by the maintainer. Each rung's `download-verification.json` still records the original k6.json.gz sha256. Scored P95 comes from the collect JSON and summary.json, which are in this tree, so `score_p95_v1.py` reproduces the verdicts without the k6 files. Steady-only P95 (descriptive) needs them.
Failed apply `typical-p95-1x-r1-20261010` is retained as evidence. Its k6.json.gz was never downloaded (generator destroyed first).
