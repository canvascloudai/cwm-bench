const COMMANDS = new Set(['wait-ready', 'run', 'collect', 'teardown', 'help']);

export function parseArgs(argv) {
  const args = [...argv];
  const parsed = {
    command: null,
    json: false,
    help: false,
    scenario: null,
    extras: [],
  };

  if (args.length === 0) {
    return parsed;
  }

  const first = args.shift();
  if (first === '--help' || first === '-h') {
    parsed.help = true;
    parsed.command = 'help';
    return parsed;
  }
  parsed.command = first;

  while (args.length > 0) {
    const token = args.shift();
    if (token === '--json') {
      parsed.json = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    if (token === '--scenario') {
      if (args.length === 0) {
        const err = new Error('--scenario requires a value');
        err.code = 'INVALID_ARGS';
        throw err;
      }
      parsed.scenario = args.shift();
      continue;
    }
    if (token.startsWith('--scenario=')) {
      parsed.scenario = token.slice('--scenario='.length);
      continue;
    }
    parsed.extras.push(token);
  }

  if (parsed.command === 'help') {
    parsed.help = true;
  }

  if (parsed.command && !COMMANDS.has(parsed.command)) {
    const err = new Error(`unknown command: ${parsed.command}`);
    err.code = 'UNKNOWN_COMMAND';
    throw err;
  }

  if ((parsed.command === 'run' || parsed.command === 'collect') && !parsed.scenario) {
    const err = new Error(`${parsed.command} requires --scenario <scenario-key>`);
    err.code = 'INVALID_ARGS';
    throw err;
  }

  return parsed;
}

export function usageText() {
  return `cwm-bench worker adapter

Usage:
  node scripts/worker-adapter.mjs wait-ready --json
  node scripts/worker-adapter.mjs run --scenario <scenario-key> --json
  node scripts/worker-adapter.mjs collect --scenario <scenario-key> --json
  node scripts/worker-adapter.mjs teardown --json
  node scripts/worker-adapter.mjs --help

Commands:
  wait-ready   Capability-check (adapterVersion + supportedScenarios).
               If Terraform outputs exist, also verify ALB/app health and
               SSM reachability of the generator and app nodes.
  run          Execute one campaign scenario on the generator via SSM.
  collect      Gather Terraform outputs, resolved AMIs, CloudWatch metrics,
               and generator artifacts. Does not invent measurements.
  teardown     Stop a detached k6 run identified by CWM_CAMPAIGN_ID and
               CWM_RUN_ID. Used to recover interrupted worker runs.

Unknown commands and unknown scenarios fail (nonzero).

Scenario keys (kebab-case, discovered from this repo + public CWM rungs):
  idle, normal, peak, burst,
  pool-bound, app-bound, cpu-only,
  later-day, second-region,
  typical-fit-20, typical-fit-100, typical-fit-200,
  typical-holdout-300, typical-saturation-500,
  typical-later-day, typical-later-day-300,
  typical-second-region, typical-second-region-300

Holdouts:
  later-day      Distinct holdout. Runs only on a later UTC calendar day
                 than the fit campaign. Not an alias of normal.
  second-region  Distinct holdout. Runs in us-west-2. Not an alias of the
                 primary-region (us-east-1) run.

Typical profile (app_profile=typical, app_workers=2, pool 250):
  typical-fit-20 / typical-fit-100 / typical-fit-200 are fit rungs.
  typical-holdout-300 is a required holdout. typical-saturation-500 is an
  optional diagnostic holdout. Lean scenarios refuse a typical-profile
  stack, and typical scenarios refuse a lean stack (PROFILE_MISMATCH).
  Those keys refuse any Terraform region other than us-east-2.
  typical-later-day (100 RPS) and typical-later-day-300 (300 RPS) are the
  typical mix on a later UTC day than the fit campaign
  (CWM_FIT_CAMPAIGN_DATE or adapter state), still in us-east-2.
  typical-second-region (100 RPS) and typical-second-region-300 (300 RPS)
  are that same mix in us-west-2 only. Each pair is one apply: run 100,
  then 300, then destroy. Those keys do not loosen the us-east-2 lock
  on the other typical keys.

Burst is a supported scenario. collect must assemble required CloudWatch
datapoints plus k6 summary.json (latency percentiles and error-class
counts) before burst is treated as measured. Incomplete burst collect
fails with COLLECT_INCOMPLETE. This adapter will not invent CloudWatch
or copy the public CWM 2% / 9.55% cell.

Environment (optional):
  CWM_TERRAFORM_DIR     Terraform directory (default: <repo>/terraform)
  CWM_ADAPTER_STATE     Fit-date state file (default: <repo>/.cwm-adapter-state.json)
  CWM_CAMPAIGN_ID       Campaign id stamped on k6 tags
  CWM_RUN_ID            Run id (default: <scenario>-<utc-stamp>)
  CWM_WARMUP            k6 warmup (default 5m)
  CWM_DURATION          k6 steady duration (default 15m)
  CWM_READINESS_TIMEOUT_MS  Overall post-provision readiness timeout (default 20m)
  CWM_READINESS_POLL_MS     Delay between readiness probes (default 10s)
  AWS_REGION            Fallback AWS region if Terraform outputs are absent
`;
}
