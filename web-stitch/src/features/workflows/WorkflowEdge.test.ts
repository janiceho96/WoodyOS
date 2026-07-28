import { describe, expect, it } from 'vitest';
import { deriveWorkflowEdgeCondition, insertNodeOnEdge, mutateWorkflowEdge, replaceWorkflowEdge } from './WorkflowEdge';

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

  const catalog = [
    { type: 'agent', title: 'Agent', inputPorts: [{ id: 'input', label: 'Input', dataType: 'text', required: true }], outputPorts: [{ id: 'output', label: 'Output', dataType: 'text' }] },
    { type: 'condition', title: 'Condition', inputPorts: [{ id: 'input', label: 'Input', dataType: 'text' }], outputPorts: [{ id: 'true', label: 'True', dataType: 'boolean' }, { id: 'false', label: 'False', dataType: 'boolean' }] },
    { type: 'loop', title: 'Loop', inputPorts: [{ id: 'input', label: 'Input', dataType: 'text' }], outputPorts: [{ id: 'body', label: 'Body', dataType: 'text' }, { id: 'done', label: 'Done', dataType: 'text' }] },
    { type: 'knowledge_search', title: 'Knowledge search', inputPorts: [{ id: 'input', label: 'Input', dataType: 'text' }], outputPorts: [{ id: 'results', label: 'Results', dataType: 'collection' }] },
  ] as never;

  it('normalizes stale branch handles and commits complete reconnect metadata', () => {
    // Break caught: reconnecting an old True branch from an Agent persisting sourcePort=true and its old schema.
    const nodes = [
      { id: 'check', type: 'condition', config: {} },
      { id: 'old', type: 'agent', config: {} },
      { id: 'writer', type: 'agent', config: {} },
      { id: 'loop', type: 'loop', config: {} },
    ] as never;
    const existing = [{ source: 'check', target: 'old', condition: 'true', sourcePort: 'true', targetPort: 'input', sourceSchema: { type: 'boolean' }, targetSchema: { type: 'string' } }];

    expect(mutateWorkflowEdge({
      nodes,
      edges: existing,
      catalog,
      previous: existing[0],
      connection: { source: 'writer', target: 'loop', sourceHandle: 'true', targetHandle: 'input' },
    })).toEqual({
      edges: [{
        source: 'writer',
        target: 'loop',
        condition: 'continue',
        sourcePort: 'output',
        targetPort: 'input',
        sourceSchema: { type: 'string' },
        targetSchema: { type: 'string' },
        required: false,
        nullable: false,
      }],
    });
  });

  it('rejects unknown handles, incompatible schemas, and duplicate reconnects without graph mutation', () => {
    // Break caught: unresolved handles or invalid reconnects being persisted because only endpoint IDs were checked.
    const nodes = [
      { id: 'writer', type: 'agent', config: {} },
      { id: 'reviewer', type: 'agent', config: {} },
      { id: 'search', type: 'knowledge_search', config: {} },
    ] as never;
    const existing = [
      { source: 'writer', target: 'reviewer', sourcePort: 'output', targetPort: 'input' },
      { source: 'search', target: 'reviewer', sourcePort: 'results', targetPort: 'input' },
    ];
    const base = { nodes, edges: existing, catalog, previous: existing[0] };

    expect(mutateWorkflowEdge({ ...base, connection: { source: 'writer', target: 'reviewer', sourceHandle: 'mystery', targetHandle: 'input' } }))
      .toEqual({ edges: existing, error: 'Source handle mystery is not available on Agent.' });
    expect(mutateWorkflowEdge({ ...base, connection: { source: 'search', target: 'reviewer', sourceHandle: 'results', targetHandle: 'input' } }))
      .toEqual({ edges: existing, error: 'Results produces collection, but Input expects text.' });
    expect(mutateWorkflowEdge({
      nodes,
      edges: [{ source: 'writer', target: 'reviewer' }, { source: 'reviewer', target: 'writer' }],
      catalog,
      previous: { source: 'reviewer', target: 'writer' },
      connection: { source: 'writer', target: 'reviewer', sourceHandle: 'output', targetHandle: 'input' },
    })).toMatchObject({ error: 'That connection already exists.' });
  });

  it('applies ordinary-source outgoing replacement semantics during reconnect', () => {
    // Break caught: reconnect adding a second ordinary Agent output instead of replacing its prior outgoing edge.
    const nodes = [
      { id: 'first', type: 'agent', config: {} },
      { id: 'second', type: 'agent', config: {} },
      { id: 'third', type: 'agent', config: {} },
    ] as never;
    const existing = [
      { source: 'first', target: 'second' },
      { source: 'second', target: 'third' },
    ];

    expect(mutateWorkflowEdge({
      nodes,
      edges: existing,
      catalog,
      previous: existing[1],
      connection: { source: 'first', target: 'third', sourceHandle: 'output', targetHandle: 'input' },
    })).toEqual({
      edges: [{
        source: 'first',
        target: 'third',
        sourcePort: 'output',
        targetPort: 'input',
        sourceSchema: { type: 'string' },
        targetSchema: { type: 'string' },
        required: true,
        nullable: false,
      }],
    });
  });

  it('inserts a node by replacing one edge with two valid edges', () => {
    expect(insertNodeOnEdge(edges, edges[0], 'reviewer')).toEqual([
      { source: 'grader', target: 'loop', condition: 'continue' },
      { source: 'writer', target: 'reviewer' },
      { source: 'reviewer', target: 'grader' },
    ]);
  });
});
