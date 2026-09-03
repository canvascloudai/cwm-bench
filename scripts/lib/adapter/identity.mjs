const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requiredIdentityValue(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    const error = new Error(`${name} is required for benchmark run and collect commands`);
    error.code = 'RUN_IDENTITY_MISSING';
    throw error;
  }
  const normalized = value.trim();
  if (!ID_PATTERN.test(normalized)) {
    const error = new Error(
      `${name} must be 1-128 characters using letters, numbers, dot, underscore, colon, or hyphen`,
    );
    error.code = 'RUN_IDENTITY_INVALID';
    throw error;
  }
  return normalized;
}

export function requireRunIdentity(env, requestedScenario) {
  const campaignId = requiredIdentityValue(env, 'CWM_CAMPAIGN_ID');
  const runId = requiredIdentityValue(env, 'CWM_RUN_ID');
  const scenario = requiredIdentityValue(env, 'CWM_SCENARIO');
  if (scenario !== requestedScenario) {
    const error = new Error(
      `CWM_SCENARIO ${scenario} does not match requested scenario ${requestedScenario}`,
    );
    error.code = 'RUN_IDENTITY_MISMATCH';
    throw error;
  }
  return { campaignId, runId, scenario };
}

export function identityPayload(env, requestedScenario) {
  return {
    campaignId:
      typeof env.CWM_CAMPAIGN_ID === 'string' && env.CWM_CAMPAIGN_ID.trim()
        ? env.CWM_CAMPAIGN_ID.trim()
        : null,
    runId:
      typeof env.CWM_RUN_ID === 'string' && env.CWM_RUN_ID.trim()
        ? env.CWM_RUN_ID.trim()
        : null,
    scenario:
      typeof env.CWM_SCENARIO === 'string' && env.CWM_SCENARIO.trim()
        ? env.CWM_SCENARIO.trim()
        : requestedScenario || null,
  };
}