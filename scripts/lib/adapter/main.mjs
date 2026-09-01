import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_VERSION } from './version.mjs';
import { parseArgs, usageText } from './cli.mjs';
import { redact, redactError } from './redact.mjs';
import { getScenario } from './scenarios.mjs';
import { waitReady } from './ready.mjs';
import { runScenario } from './run.mjs';
import { collectScenario } from './collect.mjs';
import { createDefaultDeps } from './exec.mjs';
import { defaultStatePath } from './state.mjs';
import { identityPayload } from './identity.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function writeJson(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

function failPayload(err, extras = {}) {
  const redacted = redactError(err);
  return {
    ok: false,
    adapterVersion: ADAPTER_VERSION,
    error: {
      code: err && err.code ? err.code : 'ADAPTER_ERROR',
      message: redacted.message,
    },
    ...extras,
  };
}

export function createContext(options = {}) {
  const env = options.env || process.env;
  const repoRoot = options.repoRoot || REPO_ROOT;
  return {
    env,
    repoRoot,
    now: options.now || (() => new Date()),
    statePath: options.statePath || env.CWM_ADAPTER_STATE || defaultStatePath(repoRoot),
    deps: {
      ...createDefaultDeps(repoRoot, env),
      ...(options.deps || {}),
    },
  };
}

export async function dispatch(parsed, ctx) {
  if (parsed.help || parsed.command === 'help') {
    return { ok: true, help: true, text: usageText(), adapterVersion: ADAPTER_VERSION };
  }

  if (!parsed.command) {
    const err = new Error('missing command');
    err.code = 'UNKNOWN_COMMAND';
    throw err;
  }

  if (parsed.command === 'wait-ready') {
    return waitReady(ctx);
  }

  getScenario(parsed.scenario);

  if (parsed.command === 'run') {
    return runScenario(ctx, parsed.scenario);
  }
  if (parsed.command === 'collect') {
    return collectScenario(ctx, parsed.scenario);
  }

  const err = new Error(`unknown command: ${parsed.command}`);
  err.code = 'UNKNOWN_COMMAND';
  throw err;
}

export async function main(argv, options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const jsonPreferred = argv.includes('--json');

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (jsonPreferred || (argv && argv.includes('--json'))) {
      writeJson(stdout, failPayload(err));
    } else {
      stderr.write(`${redact(err.message)}\n`);
    }
    return 1;
  }

  const ctx = createContext(options);
  try {
    const result = await dispatch(parsed, ctx);
    if (result && result.help && !parsed.json) {
      stdout.write(`${result.text}\n`);
      return 0;
    }
    const payload = result.help ? { ok: true, adapterVersion: ADAPTER_VERSION, help: result.text } : result;
    writeJson(stdout, payload);
    if (payload && payload.ok === false) {
      return 1;
    }
    return 0;
  } catch (err) {
    const payload = failPayload(
      err,
      parsed.command === 'run' || parsed.command === 'collect'
        ? identityPayload(ctx.env, parsed.scenario)
        : {}
    );
    if (parsed.json || jsonPreferred) {
      writeJson(stdout, payload);
    } else {
      stderr.write(`${payload.error.code}: ${payload.error.message}\n`);
    }
    return 1;
  }
}

export { REPO_ROOT };
