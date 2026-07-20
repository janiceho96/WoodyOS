import { describe, expect, it } from 'vitest';
import { workflowDefinitionErrors } from '../src/routes/workflows.js';
import { evaluateCondition, valueAtPath } from '../src/workflows/definition.js';
import { loopResult } from '../src/workflows/runtime.js';

describe('workflow definition validation', () => {
  it('accepts a connected trigger-to-output workflow', () => {
    expect(workflowDefinitionErrors({
      nodes: [{ id: 'start', type: 'trigger', config: {} }, { id: 'finish', type: 'output', config: {} }],
      edges: [{ source: 'start', target: 'finish' }],
    })).toEqual([]);
  });

  it('rejects duplicate nodes and dangling edges before a run is queued', () => {
    expect(workflowDefinitionErrors({
      nodes: [{ id: 'start', type: 'trigger', config: {} }, { id: 'start', type: 'output', config: {} }],
      edges: [{ source: 'start', target: 'missing' }],
    })).toEqual(expect.arrayContaining(['Node IDs must be unique', 'Every edge must reference an existing node']));
  });

  it('validates output sources and downloadable formats', () => {
    expect(workflowDefinitionErrors({
      nodes: [
        { id: 'start', type: 'trigger', config: {} },
        { id: 'finish', type: 'output', config: { fromNodeId: 'missing', artifactFormats: ['pdf', 'zip', 'pdf'] } },
      ],
      edges: [{ source: 'start', target: 'finish' }],
    })).toEqual(expect.arrayContaining([
      'Output node finish has an invalid fromNodeId',
      'Output node finish artifactFormats must contain unique pdf, docx, pptx or xlsx values',
    ]));
  });

  it('accepts deterministic true and false branches', () => {
    expect(workflowDefinitionErrors({
      nodes: [
        { id: 'start', type: 'trigger', config: {} },
        { id: 'check', type: 'condition', config: { path: 'input.approved', operator: 'equals', value: true } },
        { id: 'yes', type: 'output', config: {} },
        { id: 'no', type: 'output', config: {} },
      ],
      edges: [
        { source: 'start', target: 'check' },
        { source: 'check', target: 'yes', condition: 'true' },
        { source: 'check', target: 'no', condition: 'false' },
      ],
    })).toEqual([]);
  });

  it('accepts a bounded loop with an explicit continue edge and retry policy', () => {
    expect(workflowDefinitionErrors({
      nodes: [
        { id: 'start', type: 'trigger', config: {} },
        { id: 'loop', type: 'loop', config: { mode: 'forEach', collectionPath: 'input.items', maxIterations: 10, onLimit: 'fail' } },
        { id: 'work', type: 'agent', config: { agentId: '00000000-0000-4000-8000-000000000001', retry: { maxAttempts: 3, initialDelayMs: 500, multiplier: 2, maxDelayMs: 5000 } } },
        { id: 'finish', type: 'output', config: {} },
      ],
      edges: [
        { source: 'start', target: 'loop' },
        { source: 'loop', target: 'work', condition: 'body' },
        { source: 'loop', target: 'finish', condition: 'done' },
        { source: 'work', target: 'loop', condition: 'continue' },
      ],
    })).toEqual([]);
  });

  it('rejects ambiguous branches, arbitrary cycles, and unsafe loop or retry settings', () => {
    expect(workflowDefinitionErrors({
      nodes: [
        { id: 'start', type: 'trigger', config: {} },
        { id: 'check', type: 'condition', config: {} },
        { id: 'work', type: 'agent', config: { retry: { maxAttempts: 99 } } },
        { id: 'finish', type: 'output', config: {} },
        { id: 'repeat', type: 'loop', config: { mode: 'forEach', maxIterations: 1000 } },
      ],
      edges: [
        { source: 'start', target: 'check' },
        { source: 'check', target: 'work', condition: 'true' },
        { source: 'work', target: 'finish' },
        { source: 'finish', target: 'check' },
      ],
    })).toEqual(expect.arrayContaining([
      'Condition node check needs exactly one true and one false edge',
      'Retry maxAttempts for work must be between 1 and 5',
      'Loop node repeat maxIterations must be between 1 and 100',
      'Workflow cycles are allowed only through continue edges back to loop nodes',
    ]));
  });

  it('evaluates nested state paths without executing expressions', () => {
    const state = { input: { approved: true, score: 12, tags: ['safe', 'reviewed'] } };
    expect(valueAtPath(state, 'input.score')).toBe(12);
    expect(valueAtPath(state, '__proto__.polluted')).toBeUndefined();
    expect(evaluateCondition({ path: 'input.approved', operator: 'equals', value: true }, state)).toBe(true);
    expect(evaluateCondition({ path: 'input.score', operator: 'greater_than', value: 10 }, state)).toBe(true);
    expect(evaluateCondition({ path: 'input.tags', operator: 'contains', value: 'safe' }, state)).toBe(true);
  });

  it('executes for-each and while loop decisions within hard bounds', () => {
    const forEachNode = { id: 'items', type: 'loop' as const, config: { mode: 'forEach', collectionPath: 'input.items', itemVariable: 'current', indexVariable: 'position', maxIterations: 2, onLimit: 'fail' } };
    const cursor = { nodeId: 'items', loops: {}, attempt: 1 };
    const state: Record<string, unknown> = { input: { items: ['first', 'second'] } };
    expect(loopResult(forEachNode, cursor, state)).toMatchObject({ branch: 'body', output: { iteration: 0, item: 'first' } });
    expect(state).toMatchObject({ current: 'first', position: 0 });
    cursor.loops.items.iteration = 1;
    expect(loopResult(forEachNode, cursor, state)).toMatchObject({ branch: 'body', output: { iteration: 1, item: 'second' } });
    cursor.loops.items.iteration = 2;
    expect(loopResult(forEachNode, cursor, state)).toMatchObject({ branch: 'done', output: { iterations: 2, reason: 'collection_complete' } });

    const whileNode = { id: 'while', type: 'loop' as const, config: { mode: 'while', condition: { path: 'keepGoing', operator: 'equals', value: true }, maxIterations: 1, onLimit: 'fail' } };
    const whileCursor = { nodeId: 'while', loops: {}, attempt: 1 };
    expect(loopResult(whileNode, whileCursor, { keepGoing: true })).toMatchObject({ branch: 'body' });
    whileCursor.loops.while.iteration = 1;
    expect(() => loopResult(whileNode, whileCursor, { keepGoing: true })).toThrow('iteration safety limit');
    expect(loopResult(whileNode, { nodeId: 'while', loops: {}, attempt: 1 }, { keepGoing: false })).toMatchObject({ branch: 'done', output: { reason: 'condition_false' } });
  });
});
