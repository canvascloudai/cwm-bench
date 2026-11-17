import { spawn } from 'node:child_process';

// Private transport: do not run through the generic process runner, which
// redacts stdout before parsing it (that would corrupt OCI resource IDs).
// Only fixed, dependency-injected commands; never a shell, never credentials
// in argv. OCI_CONFIG_FILE and private SSH files are runtime-only.
export function privateRunner(command, env, cwd) {
  return (args, { input, timeoutMs = 120_000, maxBytes = 4 * 1024 * 1024 } = {}) => new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(124); }, timeoutMs);
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.on('data', (chunk) => {
        if (key === 'stdout') stdout += chunk;
        else stderr += chunk;
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBytes) {
          child.kill('SIGKILL'); finish(125);
        }
      });
    }
    child.on('error', () => finish(127));
    child.on('close', (code) => finish(code ?? 1));
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}

export function createOciDeps(repoRoot, env) {
  return {
    runOci: privateRunner('oci', env),
    runOciSsh: privateRunner('ssh', env),
    runOciTerraform: privateRunner('terraform', env, env.CWM_TERRAFORM_DIR || `${repoRoot}/terraform/oci`),
  };
}
