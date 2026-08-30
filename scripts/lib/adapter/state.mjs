import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function defaultStatePath(repoRoot) {
  return path.join(repoRoot, '.cwm-adapter-state.json');
}

export async function loadState(filePath, io = {}) {
  const read = io.readFile || readFile;
  try {
    const raw = await read(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function saveState(filePath, state, io = {}) {
  const write = io.writeFile || writeFile;
  const mkdirFn = io.mkdir || mkdir;
  await mkdirFn(path.dirname(filePath), { recursive: true });
  await write(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function updateAdapterState(filePath, mutator, io = {}) {
  const state = await loadState(filePath, io);
  mutator(state);
  await saveState(filePath, state, io);
  return state;
}

export async function recordFitDate(filePath, dateUtc, io = {}) {
  return updateAdapterState(
    filePath,
    (state) => {
      if (!state.fitCampaignDateUtc) {
        state.fitCampaignDateUtc = dateUtc;
      }
      state.fitScenarios = Array.isArray(state.fitScenarios) ? state.fitScenarios : [];
    },
    io
  );
}

export async function recordLastRun(filePath, entry, io = {}) {
  return updateAdapterState(
    filePath,
    (state) => {
      state.lastRun = entry;
      state.lastRuns = state.lastRuns && typeof state.lastRuns === 'object' ? state.lastRuns : {};
      if (entry && entry.scenario) {
        state.lastRuns[entry.scenario] = entry;
      }
    },
    io
  );
}

export function fitDateFrom(state, env = {}) {
  if (env.CWM_FIT_CAMPAIGN_DATE) return String(env.CWM_FIT_CAMPAIGN_DATE);
  if (state && state.fitCampaignDateUtc) return String(state.fitCampaignDateUtc);
  return null;
}

export function lastRunFrom(state, env = {}, scenarioKey = null) {
  if (env.CWM_RUN_ID) {
    return {
      runId: String(env.CWM_RUN_ID),
      campaignId: env.CWM_CAMPAIGN_ID ? String(env.CWM_CAMPAIGN_ID) : null,
      scenario: scenarioKey,
      source: 'env',
    };
  }
  if (
    scenarioKey &&
    state &&
    state.lastRuns &&
    state.lastRuns[scenarioKey] &&
    state.lastRuns[scenarioKey].runId
  ) {
    return { ...state.lastRuns[scenarioKey], source: 'state.scenario' };
  }
  if (state && state.lastRun && state.lastRun.runId) {
    if (!scenarioKey || state.lastRun.scenario === scenarioKey) {
      return { ...state.lastRun, source: 'state.lastRun' };
    }
  }
  return null;
}
