import { describe, expect, it } from 'vitest';
import { deriveWorkflowEdgeCondition, insertNodeOnEdge, replaceWorkflowEdge } from './WorkflowEdge';

describe('workflow edge editing', () => {
  const edges = [
    { source: 'writer', target: 'grader' },
    { source: 'grader', target: 'loop', condition: 'continue' },
  ];

  it('reconnects exactly one edge while retaining its branch label', () => {
    expect(replaceWorkflowEdge(
      edges,
      edges[1],
      { source: 'grader', target: 'quality_loop' },
    )).toEqual([
      { source: 'writer', target: 'grader' },
      { source: 'grader', target: 'quality_loop', condition: 'continue' },
    ]);
  });

  it('retains explicit binding contracts when an edge is reconnected', () => {
    const contracted = [{ source: 'writer', target: 'grader', sourcePort: 'output', targetPort: 'input', sourceSchema: { type: 'object' }, targetSchema: { type: 'object' }, required: true, nullable: false }];
    expect(replaceWorkflowEdge(contracted, contracted[0], { source: 'writer', target: 'reviewer' })).toEqual([{ source: 'writer', target: 'reviewer', sourcePort: 'output', targetPort: 'input', sourceSchema: { type: 'object' }, targetSchema: { type: 'object' }, required: true, nullable: false }]);
  });

  it('updates a condition branch when reconnecting from True to False', () => {
    const edges = [{ source: 'check', target: 'yes', condition: 'true', sourcePort: 'true', targetPort: 'input' }];
    expect(replaceWorkflowEdge(edges, edges[0], { source: 'check', target: 'no', condition: 'false', sourcePort: 'false' })).toEqual([{ source: 'check', target: 'no', condition: 'false', sourcePort: 'false', targetPort: 'input' }]);
  });

  it('reuses connection condition rules for every reconnect transition', () => {
    // Break caught: carrying a stale branch label when either reconnect endpoint changes.
    expect(deriveWorkflowEdgeCondition('agent', 'agent', 'output')).toEqual({ condition: undefined });
    expect(deriveWorkflowEdgeCondition('agent', 'loop', 'output')).toEqual({ condition: 'continue' });
    expect(deriveWorkflowEdgeCondition('agent', 'loop', 'true')).toEqual({ condition: 'continue' });
    expect(deriveWorkflowEdgeCondition('knowledge_search', 'agent', 'results')).toEqual({ condition: undefined });
    expect(deriveWorkflowEdgeCondition('loop', 'agent', 'body')).toEqual({ condition: 'body' });
    expect(deriveWorkflowEdgeCondition('condition', 'agent', 'output')).toEqual({
      error: 'Use the True or False handle from a Condition.',
    });

    expect(replaceWorkflowEdge(
      [{ source: 'check', target: 'yes', condition: 'true' }],
      { source: 'check', target: 'yes', condition: 'true' },
      { source: 'writer', target: 'reviewer', condition: undefined },
    )).toEqual([{ source: 'writer', target: 'reviewer' }]);
  });

  it('inserts a node by replacing one edge with two valid edges', () => {
    expect(insertNodeOnEdge(edges, edges[0], 'reviewer')).toEqual([
      { source: 'grader', target: 'loop', condition: 'continue' },
      { source: 'writer', target: 'reviewer' },
      { source: 'reviewer', target: 'grader' },
    ]);
  });
});
