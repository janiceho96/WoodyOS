export type RuntimeErrorCategory =
  | 'transient'
  | 'rate_limited'
  | 'authentication'
  | 'validation'
  | 'policy_denied'
  | 'permanent'
  | 'cancelled'
  | 'timeout'
  | 'infrastructure'
  | 'unknown';

export type SerializedRuntimeError = {
  code: string;
  category: RuntimeErrorCategory;
  retryable: boolean;
  message: string;
  details?: unknown;
};

export class WorkflowRuntimeError extends Error {
  readonly code: string;
  readonly category: RuntimeErrorCategory;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: string,
    input: {
      category: RuntimeErrorCategory;
      retryable: boolean;
      message: string;
      details?: unknown;
      cause?: unknown;
    },
  ) {
    super(input.message, { cause: input.cause });
    this.name = 'WorkflowRuntimeError';
    this.code = code;
    this.category = input.category;
    this.retryable = input.retryable;
    this.details = input.details;
  }
}

export function runtimeError(
  code: string,
  input: {
    category: RuntimeErrorCategory;
    retryable: boolean;
    message: string;
    details?: unknown;
    cause?: unknown;
  },
) {
  return new WorkflowRuntimeError(code, input);
}

const sensitiveKey = /token|password|secret|authorization|(^|[-_])auth($|[-_])|api[-_]?key|cookie|credential|private[-_]?key|session|encrypted/i;
const namedSecret = /\b(api[-_]?key|password|token|authorization|secret|credential)\b(\s*[:=]\s*)([^\s,;]+)/gi;
const quotedNamedSecret = /(["'])(api[-_]?key|password|token|authorization|secret|credential)\1(\s*:\s*)(["'])(.*?)\4/gi;
const bearerSecret = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const keyLikeSecret = /\b(?:sk|rk|pk)_[A-Za-z0-9_-]{8,}\b|\bsk-[A-Za-z0-9_-]{8,}\b/g;

function redactEmbeddedJson(value: string) {
  let output = '';
  let cursor = 0;
  while (cursor < value.length) {
    const opening = value.slice(cursor).search(/[[{]/);
    if (opening < 0) {
      output += value.slice(cursor);
      break;
    }
    const start = cursor + opening;
    output += value.slice(cursor, start);
    const stack: string[] = [];
    let quote = '';
    let escaped = false;
    let end = -1;
    for (let index = start; index < value.length; index += 1) {
      const character = value[index]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '{' || character === '[') stack.push(character);
      else if (character === '}' || character === ']') {
        const expected = character === '}' ? '{' : '[';
        if (stack.pop() !== expected) break;
        if (stack.length === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end < 0) {
      output += value[start]!;
      cursor = start + 1;
      continue;
    }
    const candidate = value.slice(start, end);
    try {
      output += JSON.stringify(redactRuntimeValue(JSON.parse(candidate)));
    } catch {
      output += candidate;
    }
    cursor = end;
  }
  return output;
}

export function redactRuntimeMessage(value: string) {
  return redactEmbeddedJson(value)
    .replace(quotedNamedSecret, (_match, keyQuote: string, name: string, separator: string, valueQuote: string) => (
      `${keyQuote}${name}${keyQuote}${separator}${valueQuote}[REDACTED]${valueQuote}`
    ))
    .replace(namedSecret, (_match, name: string, separator: string) => `${name}${separator}[REDACTED]`)
    .replace(bearerSecret, 'Bearer [REDACTED]')
    .replace(keyLikeSecret, '[REDACTED]');
}

export function redactRuntimeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactRuntimeMessage(value);
  if (Array.isArray(value)) return value.map((item) => redactRuntimeValue(item, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  const redacted = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    sensitiveKey.test(key) ? '[REDACTED]' : redactRuntimeValue(item, seen),
  ]));
  seen.delete(value);
  return redacted;
}

const categories = new Set<RuntimeErrorCategory>([
  'transient',
  'rate_limited',
  'authentication',
  'validation',
  'policy_denied',
  'permanent',
  'cancelled',
  'timeout',
  'infrastructure',
  'unknown',
]);

function persistedRuntimeError(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const value = error as Record<string, unknown>;
  if (typeof value.code !== 'string'
    || typeof value.category !== 'string'
    || !categories.has(value.category as RuntimeErrorCategory)
    || typeof value.retryable !== 'boolean'
    || typeof value.message !== 'string') return null;
  return runtimeError(value.code, {
    category: value.category as RuntimeErrorCategory,
    retryable: value.retryable,
    message: value.message,
    details: value.details,
  });
}

export function serializeRuntimeError(error: unknown): SerializedRuntimeError {
  const normalized = error instanceof WorkflowRuntimeError
    ? error
    : persistedRuntimeError(error)
      ?? (
        runtimeError('RUNTIME_ERROR', {
          category: 'unknown',
          retryable: false,
          message: error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
            : error && typeof error === 'object' && 'message' in error
              ? String((error as { message: unknown }).message)
              : 'Unknown runtime error',
        })
      );
  return {
    code: normalized.code,
    category: normalized.category,
    retryable: normalized.retryable,
    message: redactRuntimeMessage(normalized.message).slice(0, 2_000),
    ...(normalized.details === undefined ? {} : { details: redactRuntimeValue(normalized.details) }),
  };
}
