import { describe, expect, it } from 'vitest';
import { insertNodeOnEdge, replaceWorkflowEdge } from './WorkflowEdge';

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

  it('inserts a node by replacing one edge with two valid edges', () => {
    expect(insertNodeOnEdge(edges, edges[0], 'reviewer')).toEqual([
      { source: 'grader', target: 'loop', condition: 'continue' },
      { source: 'writer', target: 'reviewer' },
      { source: 'reviewer', target: 'grader' },
    ]);
  });
});
