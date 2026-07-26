import { describe, expect, it } from 'vitest';
import {
  retryDecision,
  redactRuntimeValue,
  runtimeError,
  serializeRuntimeError,
  uncertainActionOutcome,
} from '../src/runtime/errors.js';
import {
  authoritativeTraceContext,
  authoritativeQueuedTraceContext,
  childTraceContext,
  createTraceContext,
} from '../src/runtime/trace.js';

describe('structured runtime errors', () => {
  it('serializes a recursively redacted structured error without destroying safe retry details', () => {
    const error = runtimeError('TOOL_RATE_LIMITED', {
      category: 'rate_limited',
      retryable: true,
      message: 'Provider rejected api_key=secret-value',
      details: {
        apiKey: 'secret-value',
        retryAfterMs: 2_000,
        nested: {
          authorization: 'Bearer secret-token',
          operation: 'search',
        },
      },
    });

    const serialized = serializeRuntimeError(error);

    expect(serialized).toMatchObject({
      code: 'TOOL_RATE_LIMITED',
      category: 'rate_limited',
      retryable: true,
      details: {
        apiKey: '[REDACTED]',
        retryAfterMs: 2_000,
        nested: {
          authorization: '[REDACTED]',
          operation: 'search',
        },
      },
    });
    expect(JSON.stringify(serialized)).not.toContain('secret-value');
    expect(JSON.stringify(serialized)).not.toContain('secret-token');
  });

  it('normalizes plain errors at the serialization boundary and removes secret-looking values', () => {
    const serialized = serializeRuntimeError(new Error('Request failed with password=hunter2'));

    expect(serialized).toMatchObject({
      code: 'RUNTIME_ERROR',
      category: 'unknown',
      retryable: false,
    });
    expect(serialized.message).not.toContain('hunter2');
    expect(serialized).not.toHaveProperty('stack');
  });

  it('redacts camelCase secrets inside quoted embedded JSON', () => {
    const serialized = serializeRuntimeError(
      new Error('provider body {"apiKey":"super-secret-value","retryAfterMs":2000}'),
    );

    expect(serialized.message).toContain('"apiKey":"[REDACTED]"');
    expect(serialized.message).toContain('"retryAfterMs":2000');
    expect(JSON.stringify(serialized)).not.toContain('super-secret-value');
  });

  it('revalidates and redacts a previously persisted structured error', () => {
    const serialized = serializeRuntimeError({
      code: 'PROVIDER_LIMIT',
      category: 'rate_limited',
      retryable: true,
      message: 'Retry with token=do-not-show',
      details: { retryAfterMs: 500, password: 'hidden' },
    });

    expect(serialized).toMatchObject({
      code: 'PROVIDER_LIMIT',
      category: 'rate_limited',
      retryable: true,
      details: { retryAfterMs: 500, password: '[REDACTED]' },
    });
    expect(JSON.stringify(serialized)).not.toContain('do-not-show');
    expect(JSON.stringify(serialized)).not.toContain('hidden');
  });

  it('preserves only a valid authorizationId UUID while redacting credentials', () => {
    const authorizationId = '00000000-0000-4000-8000-000000000042';

    expect(redactRuntimeValue({
      authorizationId,
      authorization: 'Bearer secret-token',
      token: 'secret-token',
      nested: { authorizationId: 'not-a-uuid' },
    })).toEqual({
      authorizationId,
      authorization: '[REDACTED]',
      token: '[REDACTED]',
      nested: { authorizationId: '[REDACTED]' },
    });
  });
});

describe('runtime retry authority', () => {
  const context = {
    attempt: 1,
    nodeRetryable: true,
    policy: {
      maxAttempts: 3,
      initialDelayMs: 250,
      multiplier: 2,
      maxDelayMs: 1_000,
    },
  };

  it.each([
    ['rate_limited', true],
    ['transient', true],
    ['timeout', true],
    ['authentication', false],
    ['validation', false],
    ['policy_denied', false],
    ['cancelled', false],
    ['permanent', false],
    ['unknown', false],
  ] as const)('classifies %s errors without trusting a broad retry flag', (category, expected) => {
    const decision = retryDecision(runtimeError('TEST_FAILURE', {
      category,
      retryable: true,
      message: 'test failure',
    }), context);

    expect(decision.retry).toBe(expected);
  });

  it('requires explicit bounded infrastructure classification', () => {
    const error = runtimeError('INFRASTRUCTURE_FAILURE', {
      category: 'infrastructure',
      retryable: true,
      message: 'temporary infrastructure failure',
    });

    expect(retryDecision(error, context).retry).toBe(false);
    expect(retryDecision(error, { ...context, allowInfrastructureRetry: true })).toMatchObject({
      retry: true,
      delayMs: 250,
    });
  });

  it('bounds rate-limit retryAfterMs to the persisted node policy', () => {
    const limited = (retryAfterMs: number) => runtimeError('RATE_LIMITED', {
      category: 'rate_limited',
      retryable: true,
      message: 'rate limited',
      details: { retryAfterMs },
    });

    expect(retryDecision(limited(9_000), context).delayMs).toBe(1_000);
    expect(retryDecision(limited(-50), context).delayMs).toBe(0);
    expect(retryDecision(limited(Number.NaN), context).delayMs).toBe(250);
  });

  it('stops when attempts are exhausted or the normalized error vetoes retry', () => {
    const transient = runtimeError('TRANSIENT_FAILURE', {
      category: 'transient',
      retryable: true,
      message: 'temporary',
    });
    const vetoed = runtimeError('TRANSIENT_FAILURE', {
      category: 'transient',
      retryable: false,
      message: 'not safe to retry',
    });

    expect(retryDecision(transient, { ...context, attempt: 3 })).toMatchObject({
      retry: false,
      reason: 'attempts_exhausted',
    });
    expect(retryDecision(vetoed, context)).toMatchObject({
      retry: false,
      reason: 'error_not_retryable',
    });
  });

  it('never retries write-capable or uncertain external outcomes', () => {
    const transient = runtimeError('TRANSIENT_FAILURE', {
      category: 'transient',
      retryable: true,
      message: 'connection dropped',
    });
    const uncertain = uncertainActionOutcome(new Error('connection dropped with token=secret'));

    expect(retryDecision(transient, { ...context, actionRisk: 'write' })).toMatchObject({
      retry: false,
      reason: 'action_not_retryable',
    });
    expect(retryDecision(transient, { ...context, actionRisk: 'unknown' })).toMatchObject({
      retry: false,
      reason: 'action_not_retryable',
    });
    expect(serializeRuntimeError(uncertain)).toMatchObject({
      code: 'ACTION_OUTCOME_UNCERTAIN',
      category: 'permanent',
      retryable: false,
    });
    expect(JSON.stringify(serializeRuntimeError(uncertain))).not.toContain('secret');
  });
});

describe('trace context', () => {
  it('creates child spans without changing the trace id', () => {
    const root = createTraceContext();
    const child = childTraceContext(root);

    expect(root.traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(root.spanId).toMatch(/^[0-9a-f-]{36}$/);
    expect(root.parentSpanId).toBeNull();
    expect(child.traceId).toBe(root.traceId);
    expect(child.parentSpanId).toBe(root.spanId);
    expect(child.spanId).not.toBe(root.spanId);
  });

  it('fails closed when a queue trace disagrees with the authoritative database trace', () => {
    const root = createTraceContext();

    expect(() => authoritativeTraceContext({
      trace_id: root.traceId,
      span_id: root.spanId,
      parent_span_id: root.parentSpanId,
    }, createTraceContext().traceId)).toThrow(expect.objectContaining({
      code: 'TRACE_CONTEXT_MISMATCH',
      retryable: false,
    }));
    expect(authoritativeTraceContext({
      trace_id: root.traceId,
      span_id: root.spanId,
      parent_span_id: root.parentSpanId,
    }, root.traceId)).toEqual(root);
  });

  it('only adopts a backfilled database trace for a pre-031 queued subject', () => {
    const root = createTraceContext();
    const migrationAppliedAt = '2026-07-26T12:00:00.000Z';
    const legacy = {
      trace_id: root.traceId,
      span_id: root.spanId,
      parent_span_id: null,
      created_at: '2026-07-25T12:00:00.000Z',
    };
    const current = { ...legacy, created_at: '2026-07-27T12:00:00.000Z' };

    expect(authoritativeQueuedTraceContext(legacy, undefined, migrationAppliedAt)).toEqual(root);
    expect(() => authoritativeQueuedTraceContext(current, undefined, migrationAppliedAt)).toThrow(
      expect.objectContaining({ code: 'TRACE_CONTEXT_REQUIRED' }),
    );
    expect(() => authoritativeQueuedTraceContext(legacy, createTraceContext().traceId, migrationAppliedAt)).toThrow(
      expect.objectContaining({ code: 'TRACE_CONTEXT_MISMATCH' }),
    );
  });
});
