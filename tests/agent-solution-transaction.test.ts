import { beforeEach, describe, expect, it, vi } from 'vitest';
import { starterSolutions } from '../src/solutions/catalog.js';

const queryMock = vi.fn();
const releaseMock = vi.fn();
vi.mock('../src/db/client.js', () => ({
  db: { connect: vi.fn(async () => ({ query: queryMock, release: releaseMock })) },
}));

describe('agent solution installation transaction', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
  });

  it('rolls back every partial resource when an insert fails', async () => {
    let agentInsertCount = 0;
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM agent_solution_installations')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO agents')) {
        agentInsertCount++;
        if (agentInsertCount === 2) throw new Error('simulated database failure');
        return { rowCount: 1, rows: [{ id: '00000000-0000-4000-8000-000000000001' }] };
      }
      return { rowCount: 1, rows: [] };
    });
    const { installAgentSolution } = await import('../src/solutions/installer.js');
    await expect(installAgentSolution({
      workspaceId: '00000000-0000-4000-8000-000000000010',
      userId: '00000000-0000-4000-8000-000000000020',
      solution: starterSolutions[0],
    })).rejects.toThrow('simulated database failure');
    expect(queryMock).toHaveBeenCalledWith('BEGIN');
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(queryMock).not.toHaveBeenCalledWith('COMMIT');
    expect(releaseMock).toHaveBeenCalledOnce();
  });
});
