import { describe, expect, it } from 'vitest';
import {
  queueJobId,
  taskJobData,
  workflowJobData,
} from '../src/queue/task-queue.js';

describe('queue job identifiers', () => {
  it('turns readable phase identifiers into deterministic BullMQ-safe IDs', () => {
    const phase = 'run-id:step:2:finish:root';
    expect(queueJobId(phase)).toBe(queueJobId(phase));
    expect(queueJobId(phase)).toMatch(/^[a-f0-9]{64}$/);
    expect(queueJobId(phase)).not.toContain(':');
    expect(queueJobId(`${phase}:retry`)).not.toBe(queueJobId(phase));
  });

  it('carries the authoritative trace id in task and workflow job payloads', () => {
    const traceId = '00000000-0000-4000-8000-000000000001';
    expect(taskJobData('00000000-0000-4000-8000-000000000002', traceId)).toEqual({
      taskId: '00000000-0000-4000-8000-000000000002',
      traceId,
    });
    expect(workflowJobData('00000000-0000-4000-8000-000000000003', traceId)).toEqual({
      workflowRunId: '00000000-0000-4000-8000-000000000003',
      traceId,
    });
  });
});
