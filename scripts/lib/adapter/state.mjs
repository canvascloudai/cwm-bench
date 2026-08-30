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

export async function recordFitDate(filePath, dateUtc, io = {}) {
  const state = await loadState(filePath, io);
  if (!state.fitCampaignDateUtc) {
    state.fitCampaignDateUtc = dateUtc;
  }
  state.fitScenarios = Array.isArray(state.fitScenarios) ? state.fitScenarios : [];
  return saveState(filePath, state, io).then(() => state);
}

export function fitDateFrom(state, env = {}) {
  if (env.CWM_FIT_CAMPAIGN_DATE) return String(env.CWM_FIT_CAMPAIGN_DATE);
  if (state && state.fitCampaignDateUtc) return String(state.fitCampaignDateUtc);
  return null;
}
