import { describe, expect, it } from 'vitest';
import { advanceWorkflowCursor, WORKFLOW_STEP_LIMIT } from '../src/workflows/traversal.js';

describe('shared workflow traversal', () => {
  it('uses the production loop continuation and terminal semantics', () => {
    // Break caught: evaluation and worker incrementing/deleting loop cursors differently.
    const definition = {
      nodes: [{ id: 'loop', type: 'loop' as const, config: {} }, { id: 'body', type: 'output' as const, config: {} }, { id: 'finish', type: 'output' as const, config: {} }],
      edges: [{ source: 'loop', target: 'body', condition: 'body' }, { source: 'loop', target: 'finish', condition: 'done' }, { source: 'body', target: 'loop', condition: 'continue' }],
    };
    expect(advanceWorkflowCursor(definition, { nodeId: 'body', loops: { loop: { iteration: 0 } }, attempt: 1 }, definition.nodes[1], undefined)).toEqual({ edge: definition.edges[2], cursor: { nodeId: 'loop', loops: { loop: { iteration: 1 } }, attempt: 1, previousNodeId: 'body' } });
    expect(advanceWorkflowCursor(definition, { nodeId: 'loop', loops: { loop: { iteration: 1 } }, attempt: 1 }, definition.nodes[0], 'done')).toEqual({ edge: definition.edges[1], cursor: { nodeId: 'finish', loops: {}, attempt: 1, previousNodeId: 'loop' } });
    expect(WORKFLOW_STEP_LIMIT).toBe(10_000);
  });
});
