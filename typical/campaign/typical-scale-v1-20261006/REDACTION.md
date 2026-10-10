# REDACTION: typical-scale-v1-20261006

Same convention as typical-holdouts-v1-20261006 (account segment of ARNs -> `REDACTED`; infrastructure ids, ALB DNS, RDS identifier/endpoint, AMI, generator_ip, SHAs kept).

| | |
|---|---|
| Original (unchanged) | /workspace/typical-scale-v1-archive/typical-scale-v1.tar, sha256 49ec3b348e84320dfba9627b2019acf62c0bc12f30559067bd643818ef7f0f2b |
| Redacted tar | typical-scale-v1-redacted.tar, sha256 cfbf907edfe5514a78ce891b623846896c5491ea18fda9212f47c29d0a7c6fea (10,014 members, same names/order/modes/mtimes) |
| Redacted tree | extracted/ |
| Tooling (contains raw values; do not publish) | /workspace/typical-scale-v1-redaction-tools/ |

| Category | Replacement | Count | Files |
|---|---|---:|---:|
| AWS account id | REDACTED | 5284 | 425 |
| IAM user ARN | arn:aws:iam::REDACTED:user/REDACTED | 8 | 8 |
| IAM unique ids (AIDA/AROA/AIPA) | REDACTED | 48 | 28 |
| App-node public IPv4 (21 IPs) | REDACTED | 42 | 20 |
| App-node public DNS | ec2-REDACTED. | 42 | 20 |
| EncryptionService debug block in controller logs | one placeholder line | 108 lines | 9 |
| AKIA/ASIA key ids | armed | 0 | 0 |

Verification on extracted/: 0 standalone 12-digit numbers; 0 `arn:aws:iam::<digits>`; 0 ARNs with a numeric account segment; 0 app IPs; 0 EncryptionService lines. Remaining `arn:aws:iam::` strings are `REDACTED` account roles/instance-profiles/user and the AWS-managed `arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore`. All JSON still parses; collect metrics identical; score_scale.py on the redacted tree reproduces the same scores.
