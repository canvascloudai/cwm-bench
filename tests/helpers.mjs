export class MemoryStream {
  constructor() {
    this.chunks = [];
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  toString() {
    return this.chunks.join('');
  }
}

export function terraformOutputFixture(overrides = {}) {
  const values = {
    alb_dns: { value: 'cwm-bench-alb-example.us-east-1.elb.amazonaws.com' },
    alb_arn: {
      value:
        'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/cwm-bench-example/abc123def456',
    },
    target_group_arn: {
      value:
        'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/cwm-bench-example/def456abc123',
    },
    generator_instance_id: { value: 'i-generator1' },
    app_instance_ids: { value: ['i-app1', 'i-app2'] },
    resolved_ami_id: { value: 'ami-0123456789abcdef0' },
    ami_source: { value: 'ssm-al2023-latest' },
    rds_identifier: { value: 'cwm-bench-example' },
    rds_endpoint: { value: 'cwm-bench-example.xxxx.us-east-1.rds.amazonaws.com' },
    generator_ip: { value: '203.0.113.10' },
    dashboard_url: { value: 'https://us-east-1.console.aws.amazon.com/cloudwatch/home' },
    app_root_volume_ids: { value: ['vol-aaa', 'vol-bbb'] },
    topology_declaration: {
      value: {
        region: 'us-east-1',
        alb: 'application',
        app_count: 2,
        app_instance_type: 'm5.large',
        app_pool_size: 250,
        db_instance_class: 'db.r5.large',
        mysql_max_connections: 500,
        test_id: 'test-campaign',
      },
    },
    ...overrides,
  };
  return JSON.stringify(values);
}

export function createAwsMock(handlers = {}) {
  const calls = [];
  async function runAws(args) {
    calls.push(args);
    const key = `${args[0]}.${args[1] || ''}`;
    if (typeof handlers[key] === 'function') {
      return handlers[key](args, calls);
    }
    if (typeof handlers.default === 'function') {
      return handlers.default(args, calls);
    }
    return { code: 1, stdout: '', stderr: `unmocked aws ${key}` };
  }
  runAws.calls = calls;
  return runAws;
}

export function ssmOnlineHandlers(options = {}) {
  const region = options.region || 'us-east-1';
  const poolSize = options.poolSize == null ? 250 : options.poolSize;
  const invocations = options.invocations || {};
  let commandSeq = 0;
  const commandScripts = new Map();
  return {
    'ssm.describe-instance-information': async () => ({
      code: 0,
      stdout: JSON.stringify({
        InstanceInformationList: [{ PingStatus: 'Online', AgentVersion: '3.0.0' }],
      }),
      stderr: '',
    }),
    'ssm.send-command': async (args) => {
      commandSeq += 1;
      const commandId = `cmd-${commandSeq}`;
      const parametersIndex = args.indexOf('--parameters');
      const parameters = parametersIndex >= 0 ? JSON.parse(args[parametersIndex + 1]) : {};
      commandScripts.set(commandId, Array.isArray(parameters.commands) ? parameters.commands.join('\n') : '');
      return {
        code: 0,
        stdout: JSON.stringify({ Command: { CommandId: commandId } }),
        stderr: '',
      };
    },
    'ssm.get-command-invocation': async (args) => {
      const commandId = args[args.indexOf('--command-id') + 1];
      const script = commandScripts.get(commandId) || '';
      let stdout = invocations[commandId] ||
        JSON.stringify({ status: 'ok', poolSize, service: 'cwm-bench-app' });
      if (!invocations[commandId] && script.includes('# ADAPTER_K6_START')) {
        stdout = 'ADAPTER_K6_STARTED pid=123\nresults_dir=/opt/cwm-bench/results/raw/test-campaign/test-run';
      } else if (
        !invocations[commandId] &&
        (script.includes('# ADAPTER_K6_STATUS') || script.includes('# ADAPTER_K6_STATUS_WAIT'))
      ) {
        stdout = 'ADAPTER_K6_COMPLETE exit=0\ncompleted_at=2026-09-01T00:10:00Z';
      } else if (!invocations[commandId] && script.includes('ADAPTER_TEARDOWN')) {
        stdout = 'ADAPTER_TEARDOWN_OK';
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          Status: 'Success',
          StandardOutputContent: stdout,
          StandardErrorContent: '',
          ResponseCode: 0,
        }),
        stderr: '',
      };
    },
    'cloudwatch.get-metric-statistics': async () => ({
      code: 0,
      stdout: JSON.stringify({
        Label: 'CPUUtilization',
        Datapoints: [],
      }),
      stderr: '',
    }),
    region,
  };
}

export function k6SummaryFixture(overrides = {}) {
  return {
    metrics: {
      http_req_duration: {
        type: 'trend',
        values: {
          avg: 60,
          min: 10,
          med: 45,
          max: 400,
          'p(90)': 100,
          'p(95)': 120,
          'p(99)': 300,
        },
      },
      http_reqs: { type: 'counter', values: { count: 15000, rate: 16.6 } },
      http_req_failed: { type: 'rate', values: { rate: 0.01, passes: 150, fails: 14850 } },
      errors_by_class: { type: 'counter', values: { count: 3, rate: 0.003 } },
      'errors_by_class{error_class:db_timeout}': {
        type: 'counter',
        values: { count: 3, rate: 0.003 },
      },
    },
    ...overrides,
  };
}

export function artifactListingStdout(
  summary,
  dir = '/opt/cwm-bench/results/raw/test-campaign/burst-1',
  identity = null
) {
  const parts = dir.split('/').filter(Boolean);
  const runId = parts.at(-1);
  const scenario = [
    'second-region',
    'pool-bound',
    'app-bound',
    'cpu-only',
    'later-day',
    'normal',
    'burst',
    'peak',
    'idle',
  ].find((key) => runId === key || String(runId).startsWith(`${key}-`));
  const resolvedIdentity = identity || {
    campaignId: parts.at(-2),
    runId,
    scenario,
  };
  return [
    `ARTIFACT_DIR=${dir}`,
    'summary.json',
    'k6.json',
    'identity.json',
    '---SUMMARY_JSON---',
    JSON.stringify(summary),
    '---END_SUMMARY_JSON---',
    '---IDENTITY_JSON---',
    JSON.stringify(resolvedIdentity),
    '---END_IDENTITY_JSON---',
  ].join('\n');
}

export function cloudWatchCompleteHandlers(options = {}) {
  const rdsBurstMin = options.rdsBurstMin == null ? 0 : options.rdsBurstMin;
  const ebsBurstMin = options.ebsBurstMin == null ? 40 : options.ebsBurstMin;
  const requestCount = options.requestCount == null ? 900 : options.requestCount;
  const target2xxCount = options.target2xxCount == null ? 900 : options.target2xxCount;
  const ts = options.timestamp || '2026-09-01T00:10:00Z';
  return {
    'cloudwatch.get-metric-statistics': async (args) => {
      const metric = args[args.indexOf('--metric-name') + 1];
      const namespace = args[args.indexOf('--namespace') + 1];
      if (metric === 'TargetResponseTime') {
        return {
          code: 0,
          stdout: JSON.stringify({
            Label: 'TargetResponseTime',
            Datapoints: [
              {
                Timestamp: ts,
                ExtendedStatistics: { p50: 0.04, p95: 0.12, p99: 0.3 },
                Unit: 'Seconds',
              },
            ],
          }),
          stderr: '',
        };
      }
      if (metric === 'BurstBalance') {
        const minimum = namespace === 'AWS/RDS' ? rdsBurstMin : ebsBurstMin;
        return {
          code: 0,
          stdout: JSON.stringify({
            Label: 'BurstBalance',
            Datapoints: [{ Timestamp: ts, Minimum: minimum, Unit: 'Percent' }],
          }),
          stderr: '',
        };
      }
      if (metric === 'DatabaseConnections') {
        return {
          code: 0,
          stdout: JSON.stringify({
            Label: 'DatabaseConnections',
            Datapoints: [{ Timestamp: ts, Average: 80, Maximum: 120, Unit: 'Count' }],
          }),
          stderr: '',
        };
      }
      if (metric === 'CPUUtilization') {
        return {
          code: 0,
          stdout: JSON.stringify({
            Label: 'CPUUtilization',
            Datapoints: [{ Timestamp: ts, Average: 35.5, Maximum: 50, Unit: 'Percent' }],
          }),
          stderr: '',
        };
      }
      if (metric === 'RequestCount' || String(metric).startsWith('HTTPCode_')) {
        const isTarget5xx = metric === 'HTTPCode_Target_5XX_Count';
        const isElb5xx = metric === 'HTTPCode_ELB_5XX_Count';
        if ((isTarget5xx && options.omitTarget5xx) || (isElb5xx && options.omitElb5xx)) {
          return {
            code: 0,
            stdout: JSON.stringify({ Label: metric, Datapoints: [] }),
            stderr: '',
          };
        }
        const sum = isTarget5xx || isElb5xx
          ? (options.alb5xxCount == null ? 4 : options.alb5xxCount)
          : metric === 'RequestCount'
            ? requestCount
            : target2xxCount;
        return {
          code: 0,
          stdout: JSON.stringify({
            Label: metric,
            Datapoints: [{ Timestamp: ts, Sum: sum, Unit: 'Count' }],
          }),
          stderr: '',
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ Label: metric, Datapoints: [] }),
        stderr: '',
      };
    },
  };
}

export function collectCompleteHandlers(options = {}) {
  const summary = options.summary || k6SummaryFixture();
  const dir = options.dir || '/opt/cwm-bench/results/raw/test-campaign/burst-1';
  return {
    ...ssmOnlineHandlers(options),
    ...cloudWatchCompleteHandlers(options),
    'ssm.get-command-invocation': async () => ({
      code: 0,
      stdout: JSON.stringify({
        Status: 'Success',
        StandardOutputContent: artifactListingStdout(summary, dir, options.identity),
        StandardErrorContent: '',
        ResponseCode: 0,
      }),
      stderr: '',
    }),
  };
}
