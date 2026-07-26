import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StoredLease = {
  ownerId: string;
  expiresAt: number;
};

const state = vi.hoisted(() => ({
  now: 1_000_000,
  leases: new Map<string, StoredLease>(),
  statements: [] as Array<{ sql: string; values: unknown[] }>,
  heartbeatFailure: null as Error | null,
  heartbeatPending: null as Promise<never> | null,
  releaseAttempts: 0,
  releasePending: null as Promise<never> | null,
}));

function key(subjectType: unknown, subjectId: unknown) {
  return `${String(subjectType)}:${String(subjectId)}`;
}

vi.mock('../src/db/client.js', () => ({
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    state.statements.push({ sql, values });
    const leaseKey = key(values[0], values[1]);
    const ttlMs = Number(values[3] ?? 30_000);
    if (sql.includes('INSERT INTO execution_leases')) {
      const existing = state.leases.get(leaseKey);
      if (existing && existing.expiresAt > state.now) return { rowCount: 0, rows: [] };
      state.leases.set(leaseKey, {
        ownerId: String(values[2]),
        expiresAt: state.now + ttlMs,
      });
      return { rowCount: 1, rows: [{ owner_id: values[2] }] };
    }
    if (sql.includes('UPDATE execution_leases')) {
      if (state.heartbeatPending) return state.heartbeatPending;
      if (state.heartbeatFailure) throw state.heartbeatFailure;
      const existing = state.leases.get(leaseKey);
      if (!existing || existing.ownerId !== values[2] || existing.expiresAt <= state.now) {
        return { rowCount: 0, rows: [] };
      }
      existing.expiresAt = state.now + ttlMs;
      return { rowCount: 1, rows: [{ owner_id: existing.ownerId }] };
    }
    if (sql.includes('DELETE FROM execution_leases')) {
      state.releaseAttempts += 1;
      if (state.releasePending) return state.releasePending;
      const existing = state.leases.get(leaseKey);
      if (!existing || existing.ownerId !== values[2]) return { rowCount: 0, rows: [] };
      state.leases.delete(leaseKey);
      return { rowCount: 1, rows: [{ owner_id: values[2] }] };
    }
    return { rowCount: 0, rows: [] };
  }),
}));

import {
  acquireLease,
  heartbeatLease,
  isLeaseFailure,
  releaseLease,
  startLeaseHeartbeat,
} from '../src/runtime/leases.js';
import { serializeRuntimeError } from '../src/runtime/errors.js';

const subject = {
  kind: 'task' as const,
  id: '00000000-0000-4000-8000-000000000001',
};

describe('execution leases', () => {
  beforeEach(() => {
    state.now = 1_000_000;
    state.leases = new Map();
    state.statements = [];
    state.heartbeatFailure = null;
    state.heartbeatPending = null;
    state.releaseAttempts = 0;
    state.releasePending = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows one live owner and uses one atomic takeover statement', async () => {
    await expect(acquireLease(subject, 'worker-a')).resolves.toBe(true);
    await expect(acquireLease(subject, 'worker-b')).resolves.toBe(false);

    const acquisitions = state.statements.filter(({ sql }) => sql.includes('INSERT INTO execution_leases'));
    expect(acquisitions).toHaveLength(2);
    expect(acquisitions.every(({ sql }) => (
      sql.includes('ON CONFLICT')
      && sql.includes('DO UPDATE')
      && sql.includes('execution_leases.expires_at <= now()')
    ))).toBe(true);
    expect(state.statements.some(({ sql }) => sql.trimStart().startsWith('SELECT'))).toBe(false);
  });

  it('allows a new owner to take over only after DB-time expiry', async () => {
    await acquireLease(subject, 'worker-a');
    state.now += 30_001;

    await expect(acquireLease(subject, 'worker-b')).resolves.toBe(true);
    expect(state.leases.get(key('task', subject.id))?.ownerId).toBe('worker-b');
  });

  it('rejects former-owner heartbeat and release after takeover', async () => {
    await acquireLease(subject, 'worker-a');
    state.now += 30_001;
    await acquireLease(subject, 'worker-b');

    await expect(heartbeatLease(subject, 'worker-a')).resolves.toBe(false);
    await expect(releaseLease(subject, 'worker-a')).resolves.toBe(false);
    await expect(heartbeatLease(subject, 'worker-b')).resolves.toBe(true);
    await expect(releaseLease(subject, 'worker-b')).resolves.toBe(true);

    const heartbeat = state.statements.find(({ sql }) => sql.includes('UPDATE execution_leases'));
    const release = state.statements.find(({ sql }) => sql.includes('DELETE FROM execution_leases'));
    expect(heartbeat?.sql).toContain('owner_id=$3');
    expect(release?.sql).toContain('owner_id=$3');
  });

  it.each([
    { failure: null, label: 'ownership loss' },
    { failure: new Error('database heartbeat failed with token=secret'), label: 'heartbeat failure' },
  ])('aborts and stops its unref timer on $label', async ({ failure }) => {
    vi.useFakeTimers();
    await acquireLease(subject, 'worker-a');
    const heartbeat = startLeaseHeartbeat(subject, 'worker-a', {
      intervalMs: 10_000,
    });
    if (failure) {
      state.heartbeatFailure = failure;
    } else {
      state.now += 30_001;
      await acquireLease(subject, 'worker-b');
    }

    await vi.advanceTimersByTimeAsync(10_000);

    expect(heartbeat.signal.aborted).toBe(true);
    expect(isLeaseFailure(heartbeat.signal.reason)).toBe(true);
    expect(serializeRuntimeError(heartbeat.signal.reason)).toMatchObject({
      code: 'EXECUTION_LEASE_LOST',
      category: 'infrastructure',
      retryable: false,
    });
    expect(JSON.stringify(serializeRuntimeError(heartbeat.signal.reason))).not.toContain('secret');
    await heartbeat.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds stop on a pending heartbeat and consumes a late rejection before release', async () => {
    vi.useFakeTimers();
    await acquireLease(subject, 'worker-a');
    let rejectHeartbeat!: (error: Error) => void;
    state.heartbeatPending = new Promise<never>((_resolve, reject) => {
      rejectHeartbeat = reject;
    });
    const heartbeat = startLeaseHeartbeat(subject, 'worker-a', {
      intervalMs: 10,
      cleanupTimeoutMs: 5,
    });
    await vi.advanceTimersByTimeAsync(10);

    const stopped = heartbeat.stop();
    await vi.advanceTimersByTimeAsync(5);
    await expect(stopped).resolves.toBe(false);
    await expect(releaseLease(subject, 'worker-a', { cleanupTimeoutMs: 5 })).resolves.toBe(true);
    expect(state.releaseAttempts).toBe(1);

    rejectHeartbeat(new Error('late heartbeat token=must-not-leak'));
    await vi.runAllTicks();
    expect(state.leases.get(key('task', subject.id))).toBeUndefined();
  });

  it('bounds release and consumes a late database rejection', async () => {
    vi.useFakeTimers();
    await acquireLease(subject, 'worker-a');
    let rejectRelease!: (error: Error) => void;
    state.releasePending = new Promise<never>((_resolve, reject) => {
      rejectRelease = reject;
    });

    const released = releaseLease(subject, 'worker-a', { cleanupTimeoutMs: 5 });
    const releaseOutcome = expect(released).rejects.toMatchObject({
      code: 'EXECUTION_LEASE_CLEANUP_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(5);
    await releaseOutcome;
    expect(state.releaseAttempts).toBe(1);

    rejectRelease(new Error('late release token=must-not-leak'));
    await vi.runAllTicks();
    expect(state.leases.get(key('task', subject.id))?.ownerId).toBe('worker-a');
  });
});
