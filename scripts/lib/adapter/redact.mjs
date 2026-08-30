/**
 * Redact credentials and connection strings from text that may hit
 * stdout, stderr, or adapter artifacts. Never invent replacements that
 * look like real measurements.
 */

const PATTERNS = [
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_ACCESS_KEY_ID]'],
  [/\bASIA[0-9A-Z]{16}\b/g, '[REDACTED_SESSION_KEY_ID]'],
  [/(?<=AWS_SECRET_ACCESS_KEY[=:\s]+)['"]?([A-Za-z0-9/+=]{20,})['"]?/gi, '[REDACTED]'],
  [/(?<=AWS_ACCESS_KEY_ID[=:\s]+)['"]?([A-Z0-9]{16,})['"]?/gi, '[REDACTED]'],
  [/(?<=AWS_SESSION_TOKEN[=:\s]+)['"]?([A-Za-z0-9/+=]+)['"]?/gi, '[REDACTED]'],
  [/(?<=SecretAccessKey[=:\s"]+)[A-Za-z0-9/+=]{20,}/gi, '[REDACTED]'],
  [/(?<=SessionToken[=:\s"]+)[A-Za-z0-9/+=]+/gi, '[REDACTED]'],
  [/(?<=MYSQL_PASSWORD[=:\s]+)['"]?([^\s'"]+)/gi, '[REDACTED]'],
  [/(?<=MYSQL_PWD[=:\s]+)['"]?([^\s'"]+)/gi, '[REDACTED]'],
  [/(?<=--password[= ])['"]?([^\s'"]+)/gi, '[REDACTED]'],
  [/(?<=password[=:\s"])[^&'"\s]+/gi, '[REDACTED]'],
  [/mysql:\/\/[^\s'"]+/gi, '[REDACTED_MYSQL_URL]'],
  [/postgres(?:ql)?:\/\/[^\s'"]+/gi, '[REDACTED_DB_URL]'],
  [/\b[A-Za-z0-9/+=]{40}\b/g, (match) => {
    // 40-char tokens that look like AWS secret keys (mixed case + /+=).
    // Do not redact lowercase hex git SHAs.
    if (/^[0-9a-f]+$/.test(match)) return match;
    if (/^[0-9a-fA-F]+$/.test(match) && match === match.toLowerCase()) return match;
    if (/[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match)) {
      return '[REDACTED_SECRET]';
    }
    return match;
  }],
];

export function redact(value) {
  if (value == null) return value;
  if (typeof value !== 'string') {
    try {
      return redact(JSON.stringify(value));
    } catch {
      return '[UNSERIALIZABLE]';
    }
  }
  let text = value;
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function redactError(err) {
  const message = redact(err && err.message ? err.message : String(err));
  const stack = err && err.stack ? redact(err.stack) : undefined;
  return { message, stack };
}
