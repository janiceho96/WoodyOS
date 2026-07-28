import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = {
  workspace: '00000000-0000-4000-8000-000000000001',
  run: '00000000-0000-4000-8000-000000000002',
  candidateTask: '00000000-0000-4000-8000-000000000003',
  graderTask: '00000000-0000-4000-8000-000000000004',
  candidateAgent: '00000000-0000-4000-8000-000000000005',
  graderAgent: '00000000-0000-4000-8000-000000000006',
  candidateVersion: '00000000-0000-4000-8000-000000000007',
  graderVersion: '00000000-0000-4000-8000-000000000008',
  outputDocument: '00000000-0000-4000-8000-000000000009',
  outputVersion: '00000000-0000-4000-8000-000000000010',
  trace: '00000000-0000-4000-8000-000000000011',
  entry: '00000000-0000-4000-8000-000000000012',
};
const hash = 'a'.repeat(64);
const parametersHash = 'b'.repeat(64);
const modelIdentity = `openai-compatible:gpt-5:${parametersHash}:${ids.graderVersion}:runtime-4`;

type Entry = {
  id: string;
  workspace_id: string;
  workflow_run_id: string;
  sequence: number;
  automated_revision: number;
  manual_revision: number;
  candidate_task_id: string;
  output_document_version_id: string;
  candidate_hash: string;
  grader_task_id: string;
  grader_agent_version_id: string;
  model_identity: string;
  result: unknown;
  exit_reason: string | null;
  trace_id: string;
  created_at: string;
};

const state = vi.hoisted(() => ({
  entries: [] as Entry[],
  leaseValid: true,
  statements: [] as string[],
  runLock: Promise.resolve(),
}));

function runRow() {
  return {
    id: ids.run,
    workspace_id: ids.workspace,
    trace_id: ids.trace,
    execution_manifest: {
      manifestVersion: 1,
      compatibility: 'exact',
      agents: {
        [ids.graderAgent]: {
          versionId: ids.graderVersion,
          version: 1,
          snapshotHash: 'c'.repeat(64),
        },
      },
      models: {
        [ids.graderAgent]: {
          provider: 'openai-compatible',
          model: 'gpt-5',
          parametersHash,
        },
      },
      runtime: { version: 'runtime-4', stateSchemaVersion: 1 },
    },
  };
}

function identityRow() {
  return {
    candidate_task_id: ids.candidateTask,
    candidate_workspace_id: ids.workspace,
    candidate_workflow_run_id: ids.run,
    output_document_version_id: ids.outputVersion,
    output_workspace_id: ids.workspace,
    output_task_id: ids.candidateTask,
    content_hash: hash,
    grader_task_id: ids.graderTask,
    grader_workspace_id: ids.workspace,
    grader_workflow_run_id: ids.run,
    grader_agent_id: ids.graderAgent,
    grader_task_agent_version_id: ids.graderVersion,
    grader_agent_version_id: ids.graderVersion,
    grader_version_workspace_id: ids.workspace,
    grader_version_agent_id: ids.graderAgent,
  };
}

vi.mock('../src/db/client.js', () => ({
  db: {
    connect: vi.fn(async () => {
      let ownsLock = false;
      let releaseRunLock: null | (() => void) = null;
      return {
        query: vi.fn(async (sql: string, values: unknown[] = []) => {
          state.statements.push(sql);
          if (sql === 'BEGIN' || sql === 'ROLLBACK') {
            if (sql === 'ROLLBACK' && ownsLock) {
              releaseRunLock?.();
              ownsLock = false;
            }
            return { rowCount: null, rows: [] };
          }
          if (sql === 'COMMIT') {
            if (ownsLock) {
              releaseRunLock?.();
              ownsLock = false;
            }
            return { rowCount: null, rows: [] };
          }
          if (sql.includes('quality-history:run')) {
            const previous = state.runLock;
            let release!: () => void;
            state.runLock = new Promise<void>((resolve) => { release = resolve; });
            await previous;
            releaseRunLock = release;
            ownsLock = true;
            const [runId, workspaceId, traceId] = values;
            return runId === ids.run && workspaceId === ids.workspace && traceId === ids.trace
              ? { rowCount: 1, rows: [runRow()] }
              : { rowCount: 0, rows: [] };
          }
          if (sql.includes('quality-history:lease')) {
            return state.leaseValid
              ? { rowCount: 1, rows: [{ id: 'lease' }] }
              : { rowCount: 0, rows: [] };
          }
          if (sql.includes('quality-history:identity')) {
            return { rowCount: 1, rows: [identityRow()] };
          }
          if (sql.includes('quality-history:existing')) {
            const existing = state.entries.find((entry) => (
              entry.workflow_run_id === values[0] && entry.sequence === values[1]
            ));
            return { rowCount: existing ? 1 : 0, rows: existing ? [structuredClone(existing)] : [] };
          }
          if (sql.includes('quality-history:insert')) {
            const entry: Entry = {
              id: state.entries.length ? `00000000-0000-4000-8000-${String(state.entries.length + 12).padStart(12, '0')}` : ids.entry,
              workspace_id: String(values[0]),
              workflow_run_id: String(values[1]),
              sequence: Number(values[2]),
              automated_revision: Number(values[3]),
              manual_revision: Number(values[4]),
              candidate_task_id: String(values[5]),
              output_document_version_id: String(values[6]),
              candidate_hash: String(values[7]),
              grader_task_id: String(values[8]),
              grader_agent_version_id: String(values[9]),
              model_identity: String(values[10]),
              result: JSON.parse(String(values[11])),
              exit_reason: values[12] == null ? null : String(values[12]),
              trace_id: String(values[13]),
              created_at: '2026-07-27T00:00:00.000Z',
            };
            state.entries.push(entry);
            return { rowCount: 1, rows: [structuredClone(entry)] };
          }
          if (sql.includes('quality-history:list')) {
            return {
              rowCount: state.entries.length,
              rows: structuredClone(state.entries).sort((left, right) => left.sequence - right.sequence),
            };
          }
          return { rowCount: 0, rows: [] };
        }),
        release: vi.fn(),
      };
    }),
  },
}));

import {
  appendQualityHistoryEntry,
  listQualityHistory,
} from '../src/quality/history.js';

function input(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: ids.workspace,
    workflowRunId: ids.run,
    sequence: 1,
    automatedRevision: 0,
    manualRevision: 0,
    candidateTaskId: ids.candidateTask,
    outputDocumentVersionId: ids.outputVersion,
    candidateHash: hash,
    graderTaskId: ids.graderTask,
    graderAgentVersionId: ids.graderVersion,
    modelIdentity,
    result: { passed: true, score: 91 },
    exitReason: 'quality_passed',
    traceId: ids.trace,
    leaseOwnerId: 'worker-owner',
    ...overrides,
  };
}

describe('immutable quality history', () => {
  beforeEach(() => {
    state.entries = [];
    state.leaseValid = true;
    state.statements = [];
    state.runLock = Promise.resolve();
  });

  it('links a grade to the exact candidate output, grader version, pinned model, and run trace', async () => {
    const entry = await appendQualityHistoryEntry(input());

    expect(entry).toMatchObject({
      id: ids.entry,
      workflowRunId: ids.run,
      candidateTaskId: ids.candidateTask,
      outputDocumentVersionId: ids.outputVersion,
      candidateHash: hash,
      graderTaskId: ids.graderTask,
      graderAgentVersionId: ids.graderVersion,
      modelIdentity,
      traceId: ids.trace,
    });
    expect(await listQualityHistory(ids.workspace, ids.run)).toEqual([entry]);
  });

  it.each([
    ['candidate task', { candidateTaskId: '00000000-0000-4000-8000-000000000101' }],
    ['candidate version', { outputDocumentVersionId: '00000000-0000-4000-8000-000000000102' }],
    ['candidate hash', { candidateHash: 'd'.repeat(64) }],
    ['grader task', { graderTaskId: '00000000-0000-4000-8000-000000000103' }],
    ['grader version', { graderAgentVersionId: '00000000-0000-4000-8000-000000000104' }],
    ['pinned model', { modelIdentity: 'caller:controlled' }],
  ])('rejects a mismatched %s identity nonretryably', async (_label, mismatch) => {
    await expect(appendQualityHistoryEntry(input(mismatch))).rejects.toMatchObject({
      code: 'QUALITY_HISTORY_IDENTITY_MISMATCH',
      retryable: false,
    });
    expect(state.entries).toEqual([]);
  });

  it('rejects cross-workspace, cross-run, and trace mismatches nonretryably', async () => {
    for (const mismatch of [
      { workspaceId: '00000000-0000-4000-8000-000000000105' },
      { workflowRunId: '00000000-0000-4000-8000-000000000106' },
      { traceId: '00000000-0000-4000-8000-000000000107' },
    ]) {
      await expect(appendQualityHistoryEntry(input(mismatch))).rejects.toMatchObject({
        code: 'QUALITY_HISTORY_IDENTITY_MISMATCH',
        retryable: false,
      });
    }
    expect(state.entries).toEqual([]);
  });

  it('returns an identical existing row for concurrent and repeated exact retries', async () => {
    const [first, concurrent] = await Promise.all([
      appendQualityHistoryEntry(input()),
      appendQualityHistoryEntry(input()),
    ]);
    const repeated = await appendQualityHistoryEntry(input());

    expect(concurrent.id).toBe(first.id);
    expect(repeated.id).toBe(first.id);
    expect(state.entries).toHaveLength(1);
  });

  it('fails closed when a sequence retry conflicts with durable history', async () => {
    await appendQualityHistoryEntry(input());

    await expect(appendQualityHistoryEntry(input({
      result: { passed: false, score: 12 },
    }))).rejects.toMatchObject({
      code: 'QUALITY_HISTORY_SEQUENCE_CONFLICT',
      retryable: false,
    });
    expect(state.entries).toHaveLength(1);
  });

  it('does not append when the workflow lease is stale', async () => {
    state.leaseValid = false;

    await expect(appendQualityHistoryEntry(input())).rejects.toMatchObject({
      code: 'EXECUTION_LEASE_LOST',
      retryable: false,
    });
    expect(state.entries).toEqual([]);
  });
});
