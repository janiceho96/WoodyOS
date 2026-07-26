import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptJson } from '../src/lib/crypto.js';
import { starterSolutions } from '../src/solutions/catalog.js';

const queryMock = vi.fn();
const releaseMock = vi.fn();
vi.mock('../src/db/client.js', () => ({
  db: { connect: vi.fn(async () => ({ query: queryMock, release: releaseMock })) },
}));

describe('agent solution installation transaction', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
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

  it('requires every declared tool before installing a tool-ready agent', async () => {
    const solution = starterSolutions.find((item) => item.slug === 'job-opportunity-researcher')!;
    queryMock.mockResolvedValue({ rowCount: 1, rows: [] });
    const { installAgentSolution } = await import('../src/solutions/installer.js');
    await expect(installAgentSolution({
      workspaceId: '00000000-0000-4000-8000-000000000010',
      userId: '00000000-0000-4000-8000-000000000020',
      solution,
    })).rejects.toThrow('MISSING_REQUIRED_SOLUTION_TOOL:agent_1:job_search');
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK');
  });

  it('persists an explicitly selected compatible read-only tool on the draft agent', async () => {
    const solution = starterSolutions.find((item) => item.slug === 'job-opportunity-researcher')!;
    const toolId = '00000000-0000-4000-8000-000000000030';
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tools WHERE')) return {
        rowCount: 1,
        rows: [{
          id: toolId,
          name: 'Jobs · Adzuna Search',
          kind: 'internal',
          config: encryptJson({ adapter: 'jobs.search', readOnly: true }),
          permissions: ['web.read', 'jobs.read'],
        }],
      };
      if (sql.includes('SELECT id FROM agent_solution_installations')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO agents')) return { rowCount: 1, rows: [{ id: '00000000-0000-4000-8000-000000000040' }] };
      if (sql.includes('SELECT revision') && sql.includes('workspace_org_settings')) return { rowCount: 1, rows: [{ revision: 1 }] };
      if (sql.includes('UPDATE workspace_org_settings')) return { rowCount: 1, rows: [{ revision: 2 }] };
      if (sql.includes('INSERT INTO departments')) return { rowCount: 1, rows: [{ id: '00000000-0000-4000-8000-000000000050' }] };
      if (sql.includes('INSERT INTO workflows')) return { rowCount: 1, rows: [{ id: '00000000-0000-4000-8000-000000000060' }] };
      return { rowCount: 1, rows: [] };
    });
    const { installAgentSolution } = await import('../src/solutions/installer.js');
    await expect(installAgentSolution({
      workspaceId: '00000000-0000-4000-8000-000000000010',
      userId: '00000000-0000-4000-8000-000000000020',
      solution,
      toolIdsByAgentKey: { agent_1: [toolId] },
    })).resolves.toMatchObject({ status: 'draft', resources: { agentIds: { agent_1: expect.any(String) } } });
    const agentInsert = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO agents'));
    expect(agentInsert?.[1]?.[9]).toBe(JSON.stringify([toolId]));
    expect(queryMock).toHaveBeenCalledWith('COMMIT');
  });

  it('rejects a permission-compatible tool when its runtime configuration can write', async () => {
    const solution = starterSolutions.find((item) => item.slug === 'job-opportunity-researcher')!;
    const toolId = '00000000-0000-4000-8000-000000000030';
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tools WHERE')) return {
        rowCount: 1,
        rows: [{
          id: toolId,
          name: 'Unsafe lookalike',
          kind: 'internal',
          config: encryptJson({ adapter: 'jobs.search', readOnly: false, method: 'POST' }),
          permissions: ['jobs.read'],
        }],
      };
      return { rowCount: 1, rows: [] };
    });
    const { installAgentSolution } = await import('../src/solutions/installer.js');
    await expect(installAgentSolution({
      workspaceId: '00000000-0000-4000-8000-000000000010',
      userId: '00000000-0000-4000-8000-000000000020',
      solution,
      toolIdsByAgentKey: { agent_1: [toolId] },
    })).rejects.toThrow('INCOMPATIBLE_OR_NON_READ_ONLY_SOLUTION_TOOL');
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK');
  });

  it('creates the solution Department atomically without dual-writing legacy teams', async () => {
    const departmentId = '00000000-0000-4000-8000-000000000050';
    let agentNumber = 0;
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM agent_solution_installations')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('INSERT INTO agents')) {
        agentNumber += 1;
        return {
          rowCount: 1,
          rows: [{
            id: `00000000-0000-4000-8000-${String(agentNumber).padStart(12, '0')}`,
          }],
        };
      }
      if (sql.includes('INSERT INTO departments')) {
        return { rowCount: 1, rows: [{ id: departmentId }] };
      }
      if (sql.includes('SELECT revision') && sql.includes('workspace_org_settings')) {
        return { rowCount: 1, rows: [{ revision: 1 }] };
      }
      if (sql.includes('UPDATE workspace_org_settings')) {
        return { rowCount: 1, rows: [{ revision: 2 }] };
      }
      if (sql.includes('INSERT INTO workflows')) {
        return {
          rowCount: 1,
          rows: [{ id: '00000000-0000-4000-8000-000000000060' }],
        };
      }
      return { rowCount: 1, rows: [{ '?column?': 1 }] };
    });
    const { installAgentSolution } = await import('../src/solutions/installer.js');
    const installed = await installAgentSolution({
      workspaceId: '00000000-0000-4000-8000-000000000010',
      userId: '00000000-0000-4000-8000-000000000020',
      solution: starterSolutions[0],
    });

    expect(installed.resources).toMatchObject({
      departmentId,
      teamId: departmentId,
    });
    const statements = queryMock.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes('INSERT INTO departments'))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO department_memberships'))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO workspace_org_settings'))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO audit_events'))).toBe(true);
    expect(statements.every((sql) => !/\b(?:agent_teams|team_memberships)\b/i.test(sql))).toBe(true);
    expect(queryMock).toHaveBeenCalledWith('COMMIT');
  });
});
