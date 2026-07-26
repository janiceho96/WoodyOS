import { describe, expect, it } from 'vitest';
import {
  runtimeError,
  serializeRuntimeError,
} from '../src/runtime/errors.js';
import {
  authoritativeTraceContext,
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
});
