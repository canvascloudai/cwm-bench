import { summarizeDatapoints, summarizeExtendedDatapoints } from './aws.mjs';

export const K6_ERROR_CLASSES = Object.freeze([
  'db_timeout',
  'too_many_connections',
  'queue_full',
  'cpu_overload',
  'internal',
  'unclassified',
]);

export const RUN_ERROR_CLASSES = Object.freeze([...K6_ERROR_CLASSES, 'iops_throttle']);

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function metricEntries(metrics, baseName) {
  return Object.entries(metrics || {}).filter(([name]) => name === baseName || name.startsWith(`${baseName}{`));
}

function pickK6Metric(metrics, baseName) {
  const entries = metricEntries(metrics, baseName);
  if (entries.length === 0) return null;
  const steady = entries.find(([name]) => name.includes('phase:steady'));
  const exact = entries.find(([name]) => name === baseName);
  return (steady || exact || entries[0])[1];
}

function countFromMetric(metric) {
  if (!metric || !metric.values) return null;
  return numberOrNull(metric.values.count);
}

function counterConsistency(reqs, failed) {
  const requestValues = reqs && reqs.values ? reqs.values : null;
  const failedValues = failed && failed.values ? failed.values : null;
  const requestCount = numberOrNull(requestValues?.count);
  const failedPasses = numberOrNull(failedValues?.passes ?? failedValues?.count);
  const failedFails = numberOrNull(failedValues?.fails);
  const failRate = numberOrNull(failedValues?.rate);
  const reasons = [];

  if (
    requestCount != null
    && failedPasses != null
    && failedFails != null
    && failedPasses + failedFails !== requestCount
  ) {
    reasons.push(
      `http_req_failed passes plus fails (${failedPasses + failedFails}) does not match http_reqs total ${requestCount}`,
    );
  }
  if (requestCount != null && failedPasses != null && failRate != null && requestCount > 0) {
    const expectedFailRate = failedPasses / requestCount;
    if (Math.abs(expectedFailRate - failRate) > 0.000001) {
      reasons.push(
        `http_req_failed rate ${failRate} does not match failed passes ${failedPasses} / http_reqs total ${requestCount}`,
      );
    }
  }
  return { valid: reasons.length === 0, reasons };
}

function zeroErrorClasses() {
  return Object.fromEntries(K6_ERROR_CLASSES.map((key) => [key, 0]));
}

function metricDatapoints(metric) {
  return metric && Array.isArray(metric.datapoints) ? metric.datapoints : [];
}

function metricSum(metric) {
  const points = metricDatapoints(metric);
  if (points.length === 0 || points.some((point) => typeof point.sum !== 'number')) {
    return null;
  }
  return points.reduce((total, point) => total + point.sum, 0);
}

function sameDatapointCoverage(left, right) {
  const leftPoints = metricDatapoints(left);
  const rightPoints = metricDatapoints(right);
  if (leftPoints.length === 0 || rightPoints.length === 0) return false;

  const timestamps = (points) =>
    points.map((point) => point.timestamp).filter((timestamp) => typeof timestamp === 'string').sort();
  const leftTimestamps = timestamps(leftPoints);
  const rightTimestamps = timestamps(rightPoints);
  return (
    leftTimestamps.length === leftPoints.length &&
    rightTimestamps.length === rightPoints.length &&
    leftTimestamps.length === rightTimestamps.length &&
    leftTimestamps.every((timestamp, index) => timestamp === rightTimestamps[index])
  );
}

function datapointSumsMatch(left, right) {
  if (!sameDatapointCoverage(left, right)) return false;
  const rightByTimestamp = new Map(
    metricDatapoints(right).map((point) => [point.timestamp, point.sum]),
  );
  return metricDatapoints(left).every(
    (point) => point.sum === rightByTimestamp.get(point.timestamp),
  );
}

function hasRequestSuccessEvidence(cloudwatch) {
  const requestCount = cloudwatch && cloudwatch.alb_request_count;
  const target2xx = cloudwatch && cloudwatch.alb_http_target_2xx;
  const requestSum = metricSum(requestCount);
  const target2xxSum = metricSum(target2xx);
  if (requestSum == null || target2xxSum == null || requestSum <= 0) {
    return { available: false, contradictory: false };
  }
  if (target2xxSum > requestSum) {
    return { available: false, contradictory: true };
  }
  return {
    available: datapointSumsMatch(requestCount, target2xx),
    contradictory: false,
  };
}

function metricIsMissing(metric) {
  return metricDatapoints(metric).length === 0;
}

/**
 * CloudWatch omits a 5xx series when no such response occurred. Infer zero
 * only when the same-window RequestCount and target-2xx series both have
 * datapoints and their totals agree. This makes the zero claim an identity
 * over observed traffic, rather than a default for every empty response.
 */
export function assessAlb5xxEvidence(cloudwatch) {
  const target5xx = cloudwatch && cloudwatch.alb_http_target_5xx;
  const elb5xx = cloudwatch && cloudwatch.alb_http_elb_5xx;
  const target5xxSum = metricSum(target5xx);
  const elb5xxSum = metricSum(elb5xx);
  const target5xxObserved = target5xxSum != null;
  const elb5xxObserved = elb5xxSum != null;
  const malformed5xx =
    (!metricIsMissing(target5xx) && !target5xxObserved) ||
    (!metricIsMissing(elb5xx) && !elb5xxObserved);
  const successEvidence = hasRequestSuccessEvidence(cloudwatch);
  const observed5xxHasErrors =
    (target5xxObserved && target5xxSum > 0) ||
    (elb5xxObserved && elb5xxSum > 0);
  const contradictory = successEvidence.contradictory || malformed5xx;
  const canInferMissingAsZero =
    successEvidence.available && !observed5xxHasErrors && !malformed5xx;

  return {
    target5xxPresent: target5xxObserved || (canInferMissingAsZero && metricIsMissing(target5xx)),
    elb5xxPresent: elb5xxObserved || (canInferMissingAsZero && metricIsMissing(elb5xx)),
    target5xxInferredZero: canInferMissingAsZero && metricIsMissing(target5xx),
    elb5xxInferredZero: canInferMissingAsZero && metricIsMissing(elb5xx),
    observed5xxHasErrors,
    contradictory,
  };
}

export function parseK6Summary(summary) {
  if (!summary || typeof summary !== 'object') {
    return {
      present: false,
      latency: { p50Ms: null, p95Ms: null, p99Ms: null, source: 'unmeasured' },
      latencyPercentilesPresent: false,
      errorClasses: null,
      errorClassCountsPresent: false,
      errorClassEvidence: 'missing',
      classifiedErrorCount: null,
      goodputRps: null,
      httpReqs: null,
      httpReqFailed: null,
    };
  }

  const metrics = summary.metrics && typeof summary.metrics === 'object' ? summary.metrics : {};
  const duration = pickK6Metric(metrics, 'http_req_duration');
  const values = duration && duration.values ? duration.values : {};
  const p50Ms = numberOrNull(values.med ?? values['p(50)']);
  const p95Ms = numberOrNull(values['p(95)']);
  const p99Ms = numberOrNull(values['p(99)']);
  const latencyPercentilesPresent = [p50Ms, p95Ms, p99Ms].every((value) => value != null);

  const reqs = pickK6Metric(metrics, 'http_reqs');
  const failed = pickK6Metric(metrics, 'http_req_failed');
  const rate = reqs && reqs.values ? numberOrNull(reqs.values.rate) : null;
  const requestCount = reqs && reqs.values ? numberOrNull(reqs.values.count) : null;
  const failRate = failed && failed.values ? numberOrNull(failed.values.rate) : null;
  const httpFailureCount = failed && failed.values
    ? numberOrNull(failed.values.passes ?? failed.values.count)
    : null;
  const counterConsistencyResult = reqs && failed ? counterConsistency(reqs, failed) : null;

  const errorClasses = {};
  let anyErrorMetric = false;
  let errorClassEvidence = 'missing';
  let classifiedErrorCount = 0;
  let taggedErrorMetricCount = 0;
  const errorEntries = metricEntries(metrics, 'errors_by_class');
  const steadyErrorEntries = errorEntries.filter(([name]) => name.includes('phase:steady'));
  const hasPhasedErrorEntries = errorEntries.some(([name]) => name.includes('phase:'));
  const scopedErrorEntries = steadyErrorEntries.length > 0
    ? steadyErrorEntries
    : (hasPhasedErrorEntries ? [] : errorEntries);
  for (const [name, metric] of scopedErrorEntries) {
    anyErrorMetric = true;
    const tagged = name.match(/error_class:([^,}]+)/);
    if (tagged) {
      const count = countFromMetric(metric);
      errorClasses[tagged[1]] = count;
      if (count != null) {
        taggedErrorMetricCount += 1;
        classifiedErrorCount += count;
      }
    }
  }
  if (anyErrorMetric) {
    const aggregateCount = countFromMetric(metrics.errors_by_class);
    const aggregateMatchesTags =
      aggregateCount == null ||
      (taggedErrorMetricCount > 0 && aggregateCount === classifiedErrorCount) ||
      (taggedErrorMetricCount === 0 && aggregateCount === 0);
    const hasUnclassifiedCounter =
      aggregateCount != null && taggedErrorMetricCount === 0 && aggregateCount > 0;
    const hasInvalidTaggedCount = Object.values(errorClasses).some((count) => count == null);
    const contradictsZeroFailureRate = failRate === 0 && classifiedErrorCount > 0;
    const contradictsNonzeroFailureRate =
      failRate != null && failRate > 0 && classifiedErrorCount === 0;
    if (
      aggregateMatchesTags &&
      !hasUnclassifiedCounter &&
      !hasInvalidTaggedCount &&
      !contradictsZeroFailureRate &&
      !contradictsNonzeroFailureRate
    ) {
      for (const key of K6_ERROR_CLASSES) {
        if (!(key in errorClasses)) {
          errorClasses[key] = 0;
        }
      }
      errorClassEvidence = 'classified-counter';
    } else if (
      counterConsistencyResult?.valid &&
      failRate != null &&
      failRate > 0 &&
      httpFailureCount != null
    ) {
      Object.assign(errorClasses, zeroErrorClasses(), { unclassified: httpFailureCount });
      classifiedErrorCount = httpFailureCount;
      errorClassEvidence = 'unclassified-http-failures';
    } else {
      errorClassEvidence = 'contradictory';
    }
  } else if (requestCount != null && requestCount > 0 && failRate === 0) {
    Object.assign(errorClasses, zeroErrorClasses());
    errorClassEvidence = 'zero-http-failure-rate';
  } else if (
    counterConsistencyResult?.valid &&
    requestCount != null &&
    requestCount > 0 &&
    failRate != null &&
    failRate > 0 &&
    httpFailureCount != null
  ) {
    Object.assign(errorClasses, zeroErrorClasses(), { unclassified: httpFailureCount });
    classifiedErrorCount = httpFailureCount;
    errorClassEvidence = 'unclassified-http-failures';
  }

  let goodputRps = null;
  if (rate != null) {
    goodputRps = failRate != null ? rate * (1 - failRate) : rate;
  }

  return {
    present: true,
    latency: {
      p50Ms,
      p95Ms,
      p99Ms,
      source: latencyPercentilesPresent ? 'k6' : 'unmeasured',
    },
    latencyPercentilesPresent,
    errorClasses: errorClassEvidence === 'missing' || errorClassEvidence === 'contradictory' ? null : errorClasses,
    errorClassCountsPresent:
      errorClassEvidence === 'classified-counter' ||
      errorClassEvidence === 'zero-http-failure-rate' ||
      errorClassEvidence === 'unclassified-http-failures',
    errorClassEvidence,
    classifiedErrorCount:
      errorClassEvidence === 'classified-counter' ||
      errorClassEvidence === 'zero-http-failure-rate' ||
      errorClassEvidence === 'unclassified-http-failures'
        ? classifiedErrorCount
        : null,
    goodputRps,
    httpReqs: reqs && reqs.values ? reqs.values : null,
    httpReqFailed: failed && failed.values ? failed.values : null,
    ...(counterConsistencyResult ? { counterConsistency: counterConsistencyResult } : {}),
  };
}

export function secondsToMs(value) {
  return value == null ? null : value * 1000;
}

export function deriveIopsThrottle(metrics) {
  const series = [];
  if (metrics.rds_burst_balance) series.push(metrics.rds_burst_balance);
  for (const [label, metric] of Object.entries(metrics || {})) {
    if (label.startsWith('app_ebs_burst_')) series.push(metric);
  }

  let observed = false;
  let zeroDatapoints = 0;
  let anyZero = false;
  for (const metric of series) {
    const points = metric && Array.isArray(metric.datapoints) ? metric.datapoints : [];
    if (points.length === 0) continue;
    observed = true;
    for (const point of points) {
      if (typeof point.minimum === 'number') {
        if (point.minimum === 0) {
          zeroDatapoints += 1;
          anyZero = true;
        }
      }
    }
  }

  if (!observed) {
    return { count: null, observed: false, burstBalanceHitZero: null };
  }
  return {
    count: anyZero ? zeroDatapoints : 0,
    observed: true,
    burstBalanceHitZero: anyZero,
  };
}

export function albLatencyFromMetrics(metrics) {
  const raw = metrics && metrics.alb_target_response_time;
  if (!raw) {
    return {
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      source: 'unmeasured',
      present: false,
    };
  }
  const p50 = raw.percentiles && raw.percentiles.p50;
  const p95 = raw.percentiles && raw.percentiles.p95;
  const p99 = raw.percentiles && raw.percentiles.p99;
  const present = Boolean(p50 && p50.available && p95 && p95.available && p99 && p99.available);
  return {
    p50Ms: p50 && p50.available ? secondsToMs(p50.value) : null,
    p95Ms: p95 && p95.available ? secondsToMs(p95.value) : null,
    p99Ms: p99 && p99.available ? secondsToMs(p99.value) : null,
    source: present ? 'alb' : 'unmeasured',
    present,
  };
}

export function metricAvailable(metrics, label) {
  const metric = metrics && metrics[label];
  return Boolean(metric && metric.summary && metric.summary.available);
}

export function requiredCloudWatchLabels(outputs) {
  const labels = ['generator_cpu', 'rds_cpu', 'rds_connections', 'rds_burst_balance'];
  for (const instanceId of outputs.appInstanceIds || []) {
    labels.push(`app_cpu_${instanceId}`);
  }
  for (const volumeId of outputs.appRootVolumeIds || []) {
    labels.push(`app_ebs_burst_${volumeId}`);
  }
  labels.push(
    'alb_request_count',
    'alb_http_target_2xx',
    'alb_http_target_5xx',
    'alb_http_elb_5xx',
    'alb_target_response_time'
  );
  return labels;
}

export function evaluateCompleteness({ outputs, cloudwatch, k6 }) {
  const missing = [];
  const alb5xxEvidence = assessAlb5xxEvidence(cloudwatch);
  const alb5xxContradictsK6 =
    k6 &&
    k6.errorClassCountsPresent &&
    k6.classifiedErrorCount === 0 &&
    alb5xxEvidence.observed5xxHasErrors;
  const alb5xxContradictory = alb5xxEvidence.contradictory || alb5xxContradictsK6;
  for (const label of requiredCloudWatchLabels(outputs)) {
    if (label === 'alb_target_response_time') {
      const alb = albLatencyFromMetrics(cloudwatch);
      if (!alb.present) missing.push(`cloudwatch:${label}:p50/p95/p99`);
      continue;
    }
    if (label === 'alb_http_target_5xx' && alb5xxContradictory) {
      missing.push('cloudwatch:alb_http_5xx:contradictory');
      continue;
    }
    if (
      label === 'alb_http_target_5xx' &&
      alb5xxEvidence.target5xxInferredZero
    ) {
      continue;
    }
    if (label === 'alb_http_elb_5xx' && alb5xxContradictory) {
      continue;
    }
    if (label === 'alb_http_elb_5xx' && alb5xxEvidence.elb5xxInferredZero) {
      continue;
    }
    if (!metricAvailable(cloudwatch, label)) {
      missing.push(`cloudwatch:${label}`);
    }
  }
  if (!k6 || !k6.present) {
    missing.push('k6:summary.json');
  } else {
    if (!k6.latencyPercentilesPresent) missing.push('k6:latency:p50/p95/p99');
    if (k6.errorClassEvidence === 'contradictory') {
      missing.push('k6:errors_by_class:contradictory');
    } else if (!k6.errorClassCountsPresent) {
      missing.push('k6:errors_by_class');
    }
  }
  return {
    complete: missing.length === 0,
    missing,
  };
}

export function assembleRunFields({ spec, outputs, cloudwatch, k6 }) {
  const iops = deriveIopsThrottle(cloudwatch);
  const errorCategories = {
    db_timeout: null,
    too_many_connections: null,
    queue_full: null,
    cpu_overload: null,
    internal: null,
    iops_throttle: iops.count,
    unclassified: null,
  };
  if (k6 && k6.errorClasses) {
    for (const key of K6_ERROR_CLASSES) {
      errorCategories[key] = k6.errorClasses[key];
    }
  }

  const albLatency = albLatencyFromMetrics(cloudwatch);
  const latency =
    k6 && k6.latencyPercentilesPresent
      ? { ...k6.latency }
      : { p50Ms: null, p95Ms: null, p99Ms: null, source: 'unmeasured' };

  const perNode = [];
  for (const instanceId of outputs.appInstanceIds || []) {
    const cpu = cloudwatch[`app_cpu_${instanceId}`];
    perNode.push({
      instanceId,
      role: 'app',
      cpuAvgPct: cpu && cpu.summary && cpu.summary.available ? cpu.summary.value : null,
      rps: null,
    });
  }
  if (outputs.generatorInstanceId) {
    const cpu = cloudwatch.generator_cpu;
    perNode.push({
      instanceId: outputs.generatorInstanceId,
      role: 'generator',
      cpuAvgPct: cpu && cpu.summary && cpu.summary.available ? cpu.summary.value : null,
      rps: k6 && k6.httpReqs && typeof k6.httpReqs.rate === 'number' ? k6.httpReqs.rate : null,
    });
  }
  if (outputs.rdsIdentifier) {
    const cpu = cloudwatch.rds_cpu;
    perNode.push({
      instanceId: outputs.rdsIdentifier,
      role: 'database',
      cpuAvgPct: cpu && cpu.summary && cpu.summary.available ? cpu.summary.value : null,
      rps: null,
    });
  }

  const connections = cloudwatch.rds_connections || { datapoints: [], summary: { available: false, value: null } };
  const connAvg = summarizeDatapoints(connections.datapoints, 'average');
  const connMax = summarizeDatapoints(connections.datapoints, 'maximum');
  const declaredCap = numberOrNull(
    outputs.topology && outputs.topology.mysql_max_connections != null
      ? Number(outputs.topology.mysql_max_connections)
      : null
  );
  let saturation = null;
  if (!connMax.available) {
    saturation = 'unknown';
  } else if (declaredCap == null) {
    saturation = 'unknown';
  } else if (connMax.value >= declaredCap) {
    saturation = 'at_cap';
  } else {
    saturation = 'below_cap';
  }

  const rdsBurst = cloudwatch.rds_burst_balance;
  const appVolumes = (outputs.appRootVolumeIds || []).map((volumeId) => {
    const metric = cloudwatch[`app_ebs_burst_${volumeId}`];
    return {
      volumeId,
      min: metric && metric.summary && metric.summary.available ? metric.summary.value : null,
    };
  });

  return {
    latency,
    albLatency,
    goodputRps: k6 ? k6.goodputRps : null,
    errorCategories,
    iopsThrottle: iops,
    perNode,
    databaseConnections: {
      avg: connAvg.available ? connAvg.value : null,
      max: connMax.available ? connMax.value : null,
      saturation,
    },
    burstBalanceMin: {
      rds: rdsBurst && rdsBurst.summary && rdsBurst.summary.available ? rdsBurst.summary.value : null,
      appVolumes,
    },
    concurrency: {
      targetRps: spec.rps,
      executor: 'k6-arrival-rate',
    },
  };
}

export function attachAlbPercentiles(metric) {
  if (!metric) return metric;
  const p50 = summarizeExtendedDatapoints(metric.datapoints, 'p50');
  const p95 = summarizeExtendedDatapoints(metric.datapoints, 'p95');
  const p99 = summarizeExtendedDatapoints(metric.datapoints, 'p99');
  return {
    ...metric,
    percentiles: { p50, p95, p99 },
    summary: {
      available: p50.available && p95.available && p99.available,
      value: p50.available ? p50.value : null,
      count: p50.count,
    },
  };
}
