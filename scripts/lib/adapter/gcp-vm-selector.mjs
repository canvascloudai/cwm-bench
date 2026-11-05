const CPU_METRIC = 'metric.type="compute.googleapis.com/instance/cpu/utilization"';
const VM_SELECTOR = /^metric\.type="compute\.googleapis\.com\/instance\/cpu\/utilization" AND metadata\.user_labels\.role="(app|generator)" AND metadata\.user_labels\.test_id="([a-z0-9][a-z0-9-]{0,62})"$/;
const FIELDS = 'items/*/instances(id,name,zone,selfLink,labels,creationTimestamp),items/*/warning,nextPageToken,unreachables,warning';

export function parseVmCpuSelector(filter) {
  const match = VM_SELECTOR.exec(filter);
  if (match) return { role: match[1], testId: match[2] };
  if (filter.includes('metadata.user_labels')) {
    throw new Error('Unsupported VM metadata selector');
  }
  return null;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validLink(link, expectedPath) {
  try {
    const url = new URL(link);
    return url.protocol === 'https:' &&
      ['www.googleapis.com', 'compute.googleapis.com'].includes(url.hostname) &&
      !url.username && !url.password && !url.port && !url.search && !url.hash &&
      url.pathname === expectedPath;
  } catch { return false; }
}

function checkWarning(warning) {
  if (warning !== undefined && (!object(warning) || warning.code !== 'NO_RESULTS_ON_PAGE')) {
    throw new Error('Compute VM inventory incomplete');
  }
}

// Inventory only: never request metadata/startup scripts, addresses, disks or
// service-account fields. No mutation or aggregation is performed.
export async function listLabeledVms({
  project, role, testId, token, fetchFn = globalThis.fetch, allowEmpty = false,
}) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) ||
      !['app', 'generator'].includes(role) ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(testId)) {
    throw new Error('Invalid VM inventory selector');
  }
  const instances = [];
  const seenIds = new Set(), seenPages = new Set();
  let pageToken;
  do {
    const url = new URL(`https://compute.googleapis.com/compute/v1/projects/${project}/aggregated/instances`);
    url.searchParams.set('filter', `labels.role = "${role}" AND labels.test_id = "${testId}"`);
    url.searchParams.set('fields', FIELDS);
    url.searchParams.set('returnPartialSuccess', 'false');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    let response, body;
    try {
      response = await fetchFn(url, {
        method: 'GET', headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
      });
      body = await response.json();
    } catch { throw new Error('Compute VM inventory network or JSON failure'); }
    if (!response.ok) throw new Error(`Compute VM inventory API failed: HTTP ${response.status}`);
    if (!object(body) || body.error ||
        (body.items !== undefined && !object(body.items)) ||
        (body.nextPageToken !== undefined && typeof body.nextPageToken !== 'string') ||
        (body.unreachables !== undefined &&
          (!Array.isArray(body.unreachables) || body.unreachables.length))) {
      throw new Error('Compute VM inventory incomplete or malformed');
    }
    checkWarning(body.warning);
    for (const [scope, group] of Object.entries(body.items || {})) {
      if (!/^zones\/[a-z][a-z0-9-]*[a-z0-9]$/.test(scope) || !object(group) ||
          group.error || (group.instances !== undefined && !Array.isArray(group.instances))) {
        throw new Error('Compute VM inventory scope malformed');
      }
      checkWarning(group.warning);
      for (const instance of group.instances || []) {
        if (!object(instance) || typeof instance.id !== 'string' ||
            !/^[1-9][0-9]{0,19}$/.test(instance.id) ||
            BigInt(instance.id) > 18446744073709551615n ||
            typeof instance.name !== 'string' || !/^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/.test(instance.name) ||
            !object(instance.labels) || instance.labels.role !== role ||
            instance.labels.test_id !== testId ||
            !validLink(instance.zone, `/compute/v1/projects/${project}/${scope}`) ||
            !validLink(instance.selfLink, `/compute/v1/projects/${project}/${scope}/instances/${instance.name}`) ||
            typeof instance.creationTimestamp !== 'string' || !Number.isFinite(Date.parse(instance.creationTimestamp)) ||
            seenIds.has(instance.id)) {
          throw new Error('Compute VM inventory identity mismatch');
        }
        seenIds.add(instance.id);
        instances.push({ id: instance.id, createdAt: instance.creationTimestamp });
      }
    }
    pageToken = body.nextPageToken;
    if (pageToken && seenPages.has(pageToken)) throw new Error('Compute VM inventory repeated a page token');
    if (pageToken) seenPages.add(pageToken);
  } while (pageToken);
  if (!instances.length && !allowEmpty) throw new Error('No matching campaign VMs; raw selection refused');
  return instances;
}

export function rawVmCpuFilter(instances) {
  if (!instances.length) throw new Error('Empty raw VM selection refused');
  // Sort strings, never coerce uint64 IDs to JS numbers.
  const ids = instances.map((instance) => instance.id).sort();
  return `${CPU_METRIC} AND (${ids.map((id) => `resource.labels.instance_id="${id}"`).join(' OR ')})`;
}

export function assertSelectedVmSeries(series, instances, project) {
  const ids = new Set(instances.map((instance) => instance.id));
  for (const item of series) {
    if (item?.resource?.type !== 'gce_instance' ||
        item.resource.labels?.project_id !== project ||
        !ids.has(item.resource.labels?.instance_id)) {
      throw new Error('Monitoring returned a VM outside the selected campaign');
    }
  }
}
