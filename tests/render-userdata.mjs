import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Render a Terraform templatefile the way user_data does.
 * Extra keys are ignored by templatefile, matching an unchanged lean template.
 */
export const APP_TEMPLATE_VARS = Object.freeze({
  app_profile: 'lean',
  app_workers: 1,
  server_js_b64: 'SERVERJS',
  package_json_b64: 'PACKAGEJSON',
  seed_sql_b64: 'SEEDSQL',
  git_ref: 'abc1234',
  git_url: 'https://example.test/cwm-bench.git',
  region: 'us-east-1',
  db_password_param: '/cwm-bench/db-password',
  mysql_host: 'db.example.invalid',
  mysql_user: 'cwmbench',
  mysql_database: 'cwmbench',
  app_pool_size: 250,
  app_queue_limit: 50,
});

export const GENERATOR_TEMPLATE_VARS = Object.freeze({
  k6_version: 'v0.54.0',
  git_ref: 'abc1234',
  git_url: 'https://example.test/cwm-bench.git',
  alb_dns: 'internal-alb.example.invalid',
  test_id: 'example-campaign',
  scenarios_js_b64: 'SCENARIOS',
  diagnostics_js_b64: 'DIAGNOSTICS',
  common_js_b64: 'COMMON',
});

export function toHcl(vars) {
  const body = Object.entries(vars)
    .map(([key, value]) => {
      if (typeof value === 'number' && Number.isFinite(value)) return `${key} = ${value}`;
      if (typeof value !== 'string') throw new Error(`unsupported template var ${key}`);
      return `${key} = ${JSON.stringify(value)}`;
    })
    .join(', ');
  return `{${body}}`;
}

export function renderTemplate(templatePath, vars) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cwm-tf-render-'));
  const env = { ...process.env, TF_IN_AUTOMATION: '1', CHECKPOINT_DISABLE: '1' };
  try {
    writeFileSync(path.join(dir, 'versions.tf'), 'terraform {\n  required_version = ">= 1.5.0"\n}\n');
    execFileSync('terraform', ['init', '-backend=false', '-input=false', '-no-color'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    const expr = `jsonencode(templatefile(${JSON.stringify(templatePath)}, ${toHcl(vars)}))`;
    const out = execFileSync('terraform', ['console', '-no-color'], {
      cwd: dir,
      input: `${expr}\n`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    const line = out
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith('"'))
      .pop();
    if (!line) {
      throw new Error(`terraform console returned no string:\n${out.slice(0, 500)}`);
    }
    // console prints a JSON string. jsonencode wraps templatefile again, so
    // the first parse is still a JSON string of the script.
    let value = JSON.parse(line);
    if (typeof value === 'string' && value.startsWith('"')) {
      value = JSON.parse(value);
    }
    if (typeof value !== 'string' || !value.startsWith('#!')) {
      throw new Error('terraform console did not return a user_data script');
    }
    return value;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
