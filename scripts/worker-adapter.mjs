#!/usr/bin/env node
/**
 * Canvas Cloud AI Admin Benchmarks worker adapter.
 *
 * Contract:
 *   node scripts/worker-adapter.mjs wait-ready --json
 *   node scripts/worker-adapter.mjs run --scenario <scenario-key> --json
 *   node scripts/worker-adapter.mjs collect --scenario <scenario-key> --json
 *
 * Success: one JSON object on stdout.
 * Failure: nonzero exit; JSON error object when --json is set.
 * Unknown command / unknown scenario: fail, never succeed.
 *
 * later-day and second-region are real holdouts, not aliases of normal
 * or of the primary-region apply. Burst and CPU-only require complete
 * CloudWatch, per-node, and identity-bound artifact evidence; this
 * adapter never invents missing values. Credentials are redacted in
 * all adapter output.
 */

import { main } from './lib/adapter/main.mjs';
import { redact } from './lib/adapter/redact.mjs';

const invoked = process.argv[1] && process.argv[1].endsWith('worker-adapter.mjs');
if (invoked) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }).catch((err) => {
    process.stderr.write(`${redact(err && err.message ? err.message : String(err))}\n`);
    process.exit(1);
  });
}

export { main };
