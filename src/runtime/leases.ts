import { query } from '../db/client.js';
import { runtimeError, serializeRuntimeError } from './errors.js';

export type LeaseSubject = {
  kind: 'task' | 'workflow_run';
  id: string;
};

export type LeaseOptions = {
  ttlMs?: number;
};

export type LeaseHeartbeatOptions = LeaseOptions & {
  intervalMs?: number;
};

export type LeaseHeartbeat = {
  signal: AbortSignal;
  stop(): Promise<void>;
};

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

function ttlMs(options: LeaseOptions) {
  return Math.min(300_000, Math.max(1_000, options.ttlMs ?? DEFAULT_LEASE_TTL_MS));
}

function heartbeatIntervalMs(options: LeaseHeartbeatOptions) {
  return Math.min(
    ttlMs(options),
    Math.max(1, options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS),
  );
}

function leaseFailure(cause?: unknown) {
  return runtimeError('EXECUTION_LEASE_LOST', {
    category: 'infrastructure',
    retryable: false,
    message: 'Execution lease ownership was lost',
    ...(cause === undefined ? {} : {
      details: { heartbeat: serializeRuntimeError(cause) },
      cause,
    }),
  });
}

export function isLeaseFailure(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'EXECUTION_LEASE_LOST',
  );
}

export async function acquireLease(
  subject: LeaseSubject,
  ownerId: string,
  options: LeaseOptions = {},
) {
  const acquired = await query(
    `INSERT INTO execution_leases(
       subject_type,subject_id,owner_id,acquired_at,heartbeat_at,expires_at
     ) VALUES($1,$2,$3,now(),now(),now()+($4::int * interval '1 millisecond'))
     ON CONFLICT(subject_type,subject_id) DO UPDATE
       SET owner_id=EXCLUDED.owner_id,
           acquired_at=now(),
           heartbeat_at=now(),
           expires_at=now()+($4::int * interval '1 millisecond')
     WHERE execution_leases.expires_at <= now()
     RETURNING owner_id`,
    [subject.kind, subject.id, ownerId, ttlMs(options)],
  );
  return Boolean(acquired.rowCount);
}

export async function heartbeatLease(
  subject: LeaseSubject,
  ownerId: string,
  options: LeaseOptions = {},
) {
  const heartbeat = await query(
    `UPDATE execution_leases
        SET heartbeat_at=now(),
            expires_at=now()+($4::int * interval '1 millisecond')
      WHERE subject_type=$1 AND subject_id=$2 AND owner_id=$3
        AND expires_at>now()
      RETURNING owner_id`,
    [subject.kind, subject.id, ownerId, ttlMs(options)],
  );
  return Boolean(heartbeat.rowCount);
}

export async function releaseLease(subject: LeaseSubject, ownerId: string) {
  const released = await query(
    `DELETE FROM execution_leases
      WHERE subject_type=$1 AND subject_id=$2 AND owner_id=$3
      RETURNING owner_id`,
    [subject.kind, subject.id, ownerId],
  );
  return Boolean(released.rowCount);
}

export function startLeaseHeartbeat(
  subject: LeaseSubject,
  ownerId: string,
  options: LeaseHeartbeatOptions = {},
): LeaseHeartbeat {
  const controller = new AbortController();
  let stopped = false;
  let active: Promise<void> | null = null;
  const tick = () => {
    if (stopped || active || controller.signal.aborted) return;
    active = (async () => {
      try {
        if (!(await heartbeatLease(subject, ownerId, options))) {
          controller.abort(leaseFailure());
        }
      } catch (error) {
        controller.abort(leaseFailure(error));
      }
    })().finally(() => {
      active = null;
    });
  };
  const timer = setInterval(tick, heartbeatIntervalMs(options));
  timer.unref();
  return {
    signal: controller.signal,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
