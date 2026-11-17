import { fault, ociJson } from './oci-commands.mjs';

/** Numeric dotted components, e.g. 8.4.7 -> [8, 4, 7]. Rejects non-numeric suffixes. */
export function parseMysqlVersion(text) {
  const value = String(text || '').trim();
  if (!/^[0-9]+(?:\.[0-9]+)*$/.test(value)) return null;
  return value.split('.').map((part) => Number(part));
}

export function compareMysqlVersions(a, b) {
  const left = parseMysqlVersion(a) || [];
  const right = parseMysqlVersion(b) || [];
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const d = (left[i] || 0) - (right[i] || 0);
    if (d) return d;
  }
  return 0;
}

function flattenListing(listing) {
  const rows = listing?.data ?? listing;
  const groups = Array.isArray(rows) ? rows : [];
  const versions = [];
  for (const group of groups) {
    if (typeof group === 'string') {
      versions.push(group);
      continue;
    }
    const minors = group?.versions ?? (group?.version ? [group] : []);
    for (const item of minors) {
      const version = typeof item === 'string' ? item : item?.version;
      if (version) versions.push(String(version));
    }
  }
  return versions;
}

function isEightX(version) {
  const parts = parseMysqlVersion(version);
  return Boolean(parts && parts[0] === 8 && version.startsWith('8.'));
}

function isEightFour(version) {
  const parts = parseMysqlVersion(version);
  return Boolean(parts && parts[0] === 8 && parts[1] === 4);
}

/**
 * Selection rule: newest listed 8.4.x; if none, newest listed 8.x; otherwise
 * refuse. "Newest" is numeric dotted-component order, not lexicographic.
 */
export function selectMysqlVersion(listing) {
  const seen = new Set();
  const eight = [];
  for (const version of flattenListing(listing)) {
    if (!isEightX(version) || seen.has(version)) continue;
    seen.add(version);
    eight.push(version);
  }
  const eightFour = eight.filter(isEightFour);
  const pool = eightFour.length ? eightFour : eight;
  if (!pool.length) {
    throw fault(
      'OCI_MYSQL_VERSION_UNAVAILABLE',
      'No MySQL 8.x version is available in this compartment; refusing to apply.',
    );
  }
  const mysqlVersion = [...pool].sort(compareMysqlVersions).at(-1);
  return {
    mysqlVersion,
    rule: eightFour.length ? 'newest_8_4' : 'newest_8_x',
    considered: [...eight].sort(compareMysqlVersions),
    source: 'oci mysql version list',
    readOnly: true,
  };
}

export async function resolveMysqlVersion(ctx, compartmentId) {
  if (!compartmentId || typeof compartmentId !== 'string') {
    throw fault(
      'OCI_MYSQL_VERSION_UNAVAILABLE',
      'A compartment id is required to list MySQL versions; refusing to apply.',
    );
  }
  const listing = await ociJson(ctx, ['mysql', 'version', 'list', '--compartment-id', compartmentId, '--all']);
  return selectMysqlVersion(listing);
}
