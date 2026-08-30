import { redact } from './redact.mjs';

const REQUIRED_OUTPUTS = [
  'alb_dns',
  'generator_instance_id',
  'app_instance_ids',
  'resolved_ami_id',
  'rds_identifier',
];

export function decodeTerraformOutput(rawJson) {
  if (rawJson == null || rawJson === '') {
    const err = new Error('terraform output was empty');
    err.code = 'TERRAFORM_OUTPUT_MISSING';
    throw err;
  }
  let parsed;
  try {
    parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  } catch (err) {
    const wrapped = new Error(`terraform output is not JSON: ${redact(err.message)}`);
    wrapped.code = 'TERRAFORM_OUTPUT_INVALID';
    throw wrapped;
  }
  const values = {};
  for (const [key, spec] of Object.entries(parsed)) {
    if (spec && Object.prototype.hasOwnProperty.call(spec, 'value')) {
      values[key] = spec.value;
    } else {
      values[key] = spec;
    }
  }
  return values;
}

export function extractOutputs(values) {
  const missing = REQUIRED_OUTPUTS.filter((key) => {
    const value = values[key];
    return value == null || value === '' || (Array.isArray(value) && value.length === 0);
  });
  return {
    albDns: values.alb_dns || null,
    generatorInstanceId: values.generator_instance_id || null,
    appInstanceIds: Array.isArray(values.app_instance_ids) ? values.app_instance_ids : [],
    resolvedAmiId: values.resolved_ami_id || null,
    amiSource: values.ami_source || null,
    rdsIdentifier: values.rds_identifier || null,
    rdsEndpoint: values.rds_endpoint || null,
    generatorIp: values.generator_ip || null,
    dashboardUrl: values.dashboard_url || null,
    appRootVolumeIds: Array.isArray(values.app_root_volume_ids)
      ? values.app_root_volume_ids
      : [],
    topology: values.topology_declaration || {},
    region: (values.topology_declaration && values.topology_declaration.region) || null,
    missing,
    raw: values,
  };
}

export function isNoStateError(text) {
  const lower = String(text || '').toLowerCase();
  return (
    lower.includes('no state') ||
    lower.includes('statestore') ||
    lower.includes('backend initialization required') ||
    lower.includes('terraform.tfstate') ||
    lower.includes('enoent') ||
    /the state file could not be found/i.test(text || '')
  );
}

export async function readTerraformOutputs(deps) {
  const run = deps.runTerraform;
  if (typeof run !== 'function') {
    const err = new Error('terraform runner is not configured');
    err.code = 'TERRAFORM_UNAVAILABLE';
    throw err;
  }
  const result = await run(['output', '-json']);
  if (result.code !== 0) {
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (isNoStateError(combined)) {
      const err = new Error('terraform state is not present (not provisioned yet)');
      err.code = 'NOT_PROVISIONED';
      throw err;
    }
    const err = new Error(redact(result.stderr || result.stdout || 'terraform output failed'));
    err.code = 'TERRAFORM_OUTPUT_FAILED';
    throw err;
  }
  const values = decodeTerraformOutput(result.stdout || '{}');
  if (!values || Object.keys(values).length === 0) {
    const err = new Error('terraform state is not present (not provisioned yet)');
    err.code = 'NOT_PROVISIONED';
    throw err;
  }
  const extracted = extractOutputs(values);
  if (extracted.missing.length === REQUIRED_OUTPUTS.length) {
    const err = new Error('terraform state is not present (not provisioned yet)');
    err.code = 'NOT_PROVISIONED';
    throw err;
  }
  if (extracted.missing.length > 0) {
    const err = new Error(
      `terraform outputs missing required keys: ${extracted.missing.join(', ')}`
    );
    err.code = 'TERRAFORM_OUTPUT_INCOMPLETE';
    throw err;
  }
  return extracted;
}
