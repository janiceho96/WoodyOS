import { randomUUID } from 'node:crypto';
import { runtimeError } from './errors.js';

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
}

export function createTraceContext(): TraceContext {
  return {
    traceId: randomUUID(),
    spanId: randomUUID(),
    parentSpanId: null,
  };
}

export function childTraceContext(parent: TraceContext): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: randomUUID(),
    parentSpanId: parent.spanId,
  };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function authoritativeTraceContext(
  row: {
    trace_id?: string | null;
    span_id?: string | null;
    parent_span_id?: string | null;
  },
  queuedTraceId?: string | null,
): TraceContext {
  if (!row.trace_id || !row.span_id || !uuid.test(row.trace_id) || !uuid.test(row.span_id)
    || (row.parent_span_id !== null && row.parent_span_id !== undefined && !uuid.test(row.parent_span_id))) {
    throw runtimeError('TRACE_CONTEXT_INVALID', {
      category: 'infrastructure',
      retryable: false,
      message: 'Authoritative runtime trace context is missing or invalid',
    });
  }
  if (queuedTraceId && queuedTraceId !== row.trace_id) {
    throw runtimeError('TRACE_CONTEXT_MISMATCH', {
      category: 'infrastructure',
      retryable: false,
      message: 'Queued trace identity does not match the authoritative runtime record',
    });
  }
  return {
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id ?? null,
  };
}

export function authoritativeQueuedTraceContext(
  row: {
    trace_id?: string | null;
    span_id?: string | null;
    parent_span_id?: string | null;
    created_at?: string | Date | null;
  },
  queuedTraceId: string | null | undefined,
  runtimeTrustMigrationAppliedAt: string | Date | null | undefined,
): TraceContext {
  const context = authoritativeTraceContext(row, queuedTraceId);
  if (queuedTraceId) return context;
  const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at ?? '');
  const migrationAt = runtimeTrustMigrationAppliedAt instanceof Date
    ? runtimeTrustMigrationAppliedAt
    : new Date(runtimeTrustMigrationAppliedAt ?? '');
  if (!Number.isFinite(createdAt.getTime())
    || !Number.isFinite(migrationAt.getTime())
    || createdAt.getTime() >= migrationAt.getTime()) {
    throw runtimeError('TRACE_CONTEXT_REQUIRED', {
      category: 'infrastructure',
      retryable: false,
      message: 'Queued trace identity is required for this runtime record',
    });
  }
  return context;
}
