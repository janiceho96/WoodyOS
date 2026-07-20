import { describe, expect, it } from 'vitest';
import { queueJobId } from '../src/queue/task-queue.js';

describe('queue job identifiers', () => {
  it('turns readable phase identifiers into deterministic BullMQ-safe IDs', () => {
    const phase = 'run-id:step:2:finish:root';
    expect(queueJobId(phase)).toBe(queueJobId(phase));
    expect(queueJobId(phase)).toMatch(/^[a-f0-9]{64}$/);
    expect(queueJobId(phase)).not.toContain(':');
    expect(queueJobId(`${phase}:retry`)).not.toBe(queueJobId(phase));
  });
});
