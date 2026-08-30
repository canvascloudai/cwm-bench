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
  return {
    'ssm.describe-instance-information': async () => ({
      code: 0,
      stdout: JSON.stringify({
        InstanceInformationList: [{ PingStatus: 'Online', AgentVersion: '3.0.0' }],
      }),
      stderr: '',
    }),
    'ssm.send-command': async () => {
      commandSeq += 1;
      return {
        code: 0,
        stdout: JSON.stringify({ Command: { CommandId: `cmd-${commandSeq}` } }),
        stderr: '',
      };
    },
    'ssm.get-command-invocation': async (args) => {
      const commandId = args[args.indexOf('--command-id') + 1];
      const stdout =
        invocations[commandId] ||
        JSON.stringify({ status: 'ok', poolSize, service: 'cwm-bench-app' });
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
