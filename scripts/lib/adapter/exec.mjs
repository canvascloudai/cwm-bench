import { spawn } from 'node:child_process';
import path from 'node:path';
import { redact } from './redact.mjs';

function stripSecretsFromEnv(env) {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (/secret|password|token|credential|connection.string/i.test(key)) {
      copy[key] = '[REDACTED]';
    }
  }
  return copy;
}

export function createProcessRunner(command, { cwd, extraEnv } = {}) {
  return function run(args, options = {}) {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: options.cwd || cwd,
        env: { ...process.env, ...(extraEnv || {}), ...(options.env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (err) => {
        resolve({
          code: 127,
          stdout: '',
          stderr: redact(err.message || String(err)),
        });
      });
      child.on('close', (code) => {
        resolve({
          code: code == null ? 1 : code,
          stdout: redact(stdout),
          stderr: redact(stderr),
        });
      });
    });
  };
}

export function createDefaultDeps(repoRoot, env) {
  const terraformDir = env.CWM_TERRAFORM_DIR
    ? path.resolve(env.CWM_TERRAFORM_DIR)
    : path.join(repoRoot, 'terraform');
  return {
    runAws: createProcessRunner('aws'),
    runTerraform: createProcessRunner('terraform', { cwd: terraformDir }),
    terraformDir,
  };
}

export { stripSecretsFromEnv };
