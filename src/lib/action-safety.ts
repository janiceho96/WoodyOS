import { createHash } from 'node:crypto';

const sensitiveKey = /token|password|secret|authorization|(^|[-_])auth($|[-_])|api[-_]?key|cookie|credential|private[-_]?key|session/i;
const likelySecretValue = /^(?:bearer\s+|sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redact(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, entry]) => [
      key,
      sensitiveKey.test(key) ? '[redacted]' : redact(entry, depth + 1),
    ]));
  }
  if (typeof value === 'string') {
    if (likelySecretValue.test(value.trim())) return '[redacted]';
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  return value;
}

export function safeActionSummary(input: Record<string, unknown>) {
  return redact(input) as Record<string, unknown>;
}

export function actionArgumentHash(input: Record<string, unknown>) {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
    return value;
  };
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

export function limitedActionResult(result: unknown) {
  const json = JSON.stringify(redact(result));
  if (json === undefined) return null;
  if (json.length <= 50_000) return JSON.parse(json) as unknown;
  return { truncated: true, preview: json.slice(0, 50_000) };
}
