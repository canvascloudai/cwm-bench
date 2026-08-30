import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PINNED_CLEANUP_REVISION } from '../../scripts/lib/adapter/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Frozen from the cleanup pin / current main. Do not rename these addresses.
const FROZEN_CLEANUP_ADDRESSES = [
  'random_password.db',
  'aws_ssm_parameter.db_password',
  'aws_db_subnet_group.main',
  'aws_db_parameter_group.main',
  'aws_db_instance.main',
  'aws_security_group.alb',
  'aws_security_group.app',
  'aws_security_group.rds',
  'aws_security_group.generator',
  'aws_vpc_security_group_ingress_rule.alb_http_from_generator',
  'aws_vpc_security_group_ingress_rule.alb_https_from_generator',
  'aws_vpc_security_group_ingress_rule.alb_http_from_cidr',
  'aws_vpc_security_group_ingress_rule.alb_https_from_cidr',
  'aws_vpc_security_group_egress_rule.alb_to_app',
  'aws_vpc_security_group_ingress_rule.app_from_alb',
  'aws_vpc_security_group_egress_rule.app_to_rds',
  'aws_vpc_security_group_egress_rule.app_https_out',
  'aws_vpc_security_group_egress_rule.app_http_out',
  'aws_vpc_security_group_ingress_rule.rds_from_app',
  'aws_vpc_security_group_egress_rule.generator_all',
  'aws_iam_role.ec2',
  'aws_iam_role_policy_attachment.ssm',
  'aws_iam_role_policy.app_ssm_db',
  'aws_iam_instance_profile.ec2',
  'aws_instance.generator',
  'aws_cloudwatch_dashboard.main',
  'aws_instance.app',
  'aws_vpc.main',
  'aws_internet_gateway.main',
  'aws_subnet.public',
  'aws_subnet.private',
  'aws_route_table.public',
  'aws_route_table_association.public',
  'aws_route_table.private',
  'aws_route_table_association.private',
  'aws_lb.main',
  'aws_lb_target_group.app',
  'aws_lb_target_group_attachment.app',
  'aws_lb_listener.http',
  'aws_lb_listener.https',
];

function readTf(name) {
  return readFileSync(path.join(ROOT, 'terraform', name), 'utf8');
}

function allTerraformText() {
  return readdirSync(path.join(ROOT, 'terraform'))
    .filter((name) => name.endsWith('.tf'))
    .map((name) => readTf(name))
    .join('\n');
}

test('aws_db_instance.main has timeouts.delete of 60m and cleanup-safe flags', () => {
  const rds = readTf('rds.tf');
  const instance = rds.match(/resource "aws_db_instance" "main"[\s\S]*$/)?.[0] || '';
  assert.match(instance, /timeouts\s*\{[\s\S]*delete\s*=\s*"60m"/);
  assert.match(instance, /timeouts\s*\{[\s\S]*create\s*=\s*"40m"/);
  assert.match(instance, /timeouts\s*\{[\s\S]*update\s*=\s*"80m"/);
  assert.match(instance, /skip_final_snapshot\s*=\s*true/);
  assert.match(instance, /deletion_protection\s*=\s*false/);
  assert.match(instance, /depends_on\s*=\s*\[[\s\S]*aws_db_subnet_group\.main/);
});

function stripHclComments(text) {
  return text
    .replace(/^\s*#.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

test('terraform does not detach RDS ENIs or broaden IAM', () => {
  const tf = stripHclComments(allTerraformText());
  assert.doesNotMatch(tf, /ec2:DetachNetworkInterface/);
  assert.doesNotMatch(tf, /ec2:Detach/);
  assert.doesNotMatch(tf, /resource\s+"aws_network_interface"/);
  assert.doesNotMatch(tf, /resource\s+"time_sleep"/);
  assert.doesNotMatch(readTf('versions.tf'), /hashicorp\/time/);

  const iam = stripHclComments(readTf('iam.tf'));
  assert.match(iam, /ssm:GetParameter/);
  assert.match(iam, /kms:Decrypt/);
  assert.match(iam, /AmazonSSMManagedInstanceCore/);
  assert.doesNotMatch(iam, /ec2:/);
  assert.doesNotMatch(iam, /rds:/);
  assert.doesNotMatch(iam, /DetachNetworkInterface/);

  // Comments may name the API to forbid it; IAM must not grant it.
  assert.match(allTerraformText(), /Do not DetachNetworkInterface/);
});

test('cleanup-compat.json resource addresses are unchanged', () => {
  const spec = JSON.parse(readFileSync(path.join(ROOT, 'scripts/cleanup-compat.json'), 'utf8'));
  assert.equal(spec.pinnedCleanupRevision, PINNED_CLEANUP_REVISION);
  assert.equal(PINNED_CLEANUP_REVISION, 'e95c5319b5c7b9cbd934735241b355df4144cab0');
  assert.deepEqual(spec.resourceAddresses, FROZEN_CLEANUP_ADDRESSES);
});

test('pinned cleanup revision is still a fetchable ancestor', () => {
  const type = execFileSync('git', ['cat-file', '-t', PINNED_CLEANUP_REVISION], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  assert.equal(type, 'commit');
  execFileSync('git', ['merge-base', '--is-ancestor', PINNED_CLEANUP_REVISION, 'HEAD'], {
    cwd: ROOT,
  });
});

test('terraform validate still passes without a new provider', () => {
  execFileSync('terraform', ['-chdir=terraform', 'init', '-backend=false', '-input=false'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const out = execFileSync('terraform', ['-chdir=terraform', 'validate', '-json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const report = JSON.parse(out);
  assert.equal(report.valid, true);
});

test('destroy-retry script is cleanup-only and retries still-in-use races', () => {
  const script = readFileSync(path.join(ROOT, 'scripts/terraform-destroy-retry.sh'), 'utf8');
  assert.match(script, /terraform init -reconfigure|init -reconfigure/);
  assert.match(script, /bounded/);
  assert.match(script, /not a campaign result/);
  assert.match(script, /worker owns that policy/);
  assert.doesNotMatch(script, /echo .*campaign complete/i);

  const work = mkdtempSync(path.join(tmpdir(), 'cwm-destroy-retry-'));
  const bin = path.join(work, 'bin');
  const tfDir = path.join(work, 'tf');
  const state = path.join(work, 'fake-tf.state');
  mkdirSync(bin);
  mkdirSync(tfDir);
  writeFileSync(
    path.join(bin, 'terraform'),
    `#!/usr/bin/env bash
set -euo pipefail
cmd=""
for a in "$@"; do
  case "$a" in
    init|destroy|refresh) cmd="$a" ;;
  esac
done
printf '%s\\t%s\\n' "$cmd" "$*" >> "${state}.calls"
if [[ "$cmd" == "init" ]]; then
  echo "initialized"
  exit 0
fi
if [[ "$cmd" == "refresh" ]]; then
  for a in "$@"; do
    if [[ "$a" == "-auto-approve" || "$a" == --auto-approve ]]; then
      echo "refresh must not receive -auto-approve" >&2
      exit 2
    fi
  done
  echo "refreshed"
  exit 0
fi
if [[ "$cmd" == "destroy" ]]; then
  n=$(grep -c $'^destroy\\t' "${state}.calls")
  if [[ "$n" -eq 1 ]]; then
    echo "Error: deleting aws_db_subnet_group.main: DependencyViolation: cannot be deleted because it is in use"
    echo "Network interface is currently in use (RDS-managed ENI)"
    exit 1
  fi
  echo "Destroy complete! Resources: 0 destroyed."
  exit 0
fi
echo "unexpected terraform invocation: $*" >&2
exit 3
`,
    { mode: 0o755 },
  );
  chmodSync(path.join(bin, 'terraform'), 0o755);

  const result = execFileSync(path.join(ROOT, 'scripts/terraform-destroy-retry.sh'), ['-var=test_id=cleanup-only', '-auto-approve'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CWM_TF_DIR: tfDir,
      CWM_DESTROY_MAX_ATTEMPTS: '4',
      CWM_DESTROY_SLEEP_SECONDS: '0',
      CWM_DESTROY_MAX_SLEEP_SECONDS: '0',
      CWM_DESTROY_DEADLINE_SECONDS: '30',
    },
  });
  assert.doesNotMatch(result, /campaign complete/i);

  const calls = readFileSync(`${state}.calls`, 'utf8');
  assert.match(calls, /^init\t.*-reconfigure/m);
  assert.match(calls, /^destroy\t/m);
  assert.match(calls, /^refresh\t/m);
  const destroyCount = calls.split('\n').filter((line) => line.startsWith('destroy\t')).length;
  assert.equal(destroyCount, 2);
});

test('destroy-retry script does not retry non-retryable errors', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'cwm-destroy-noretry-'));
  const bin = path.join(work, 'bin');
  const tfDir = path.join(work, 'tf');
  const state = path.join(work, 'fake-tf.state');
  mkdirSync(bin);
  mkdirSync(tfDir);
  writeFileSync(
    path.join(bin, 'terraform'),
    `#!/usr/bin/env bash
set -euo pipefail
cmd=""
for a in "$@"; do
  case "$a" in
    init|destroy|refresh) cmd="$a" ;;
  esac
done
printf '%s\\n' "$cmd" >> "${state}.calls"
if [[ "$cmd" == "init" ]]; then
  exit 0
fi
if [[ "$cmd" == "destroy" ]]; then
  echo "Error: No valid credential sources found for AWS Provider" >&2
  exit 1
fi
exit 0
`,
    { mode: 0o755 },
  );
  chmodSync(path.join(bin, 'terraform'), 0o755);

  let failed = false;
  try {
    execFileSync(path.join(ROOT, 'scripts/terraform-destroy-retry.sh'), [], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CWM_TF_DIR: tfDir,
        CWM_DESTROY_MAX_ATTEMPTS: '5',
        CWM_DESTROY_SLEEP_SECONDS: '0',
        CWM_DESTROY_MAX_SLEEP_SECONDS: '0',
        CWM_DESTROY_DEADLINE_SECONDS: '30',
      },
    });
  } catch (err) {
    failed = true;
    assert.match(String(err.stderr || err.stdout || err.message), /non-retryable|credential/i);
  }
  assert.equal(failed, true);
  const calls = readFileSync(`${state}.calls`, 'utf8').trim().split('\n');
  assert.deepEqual(calls, ['init', 'destroy']);
});
