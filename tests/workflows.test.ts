import { describe, expect, it } from 'vitest';
import { workflowDefinitionErrors } from '../src/routes/workflows.js';
import { evaluateCondition, valueAtPath } from '../src/workflows/definition.js';
import { loopResult } from '../src/workflows/runtime.js';
import { publicWorkflowNodeCatalog, workflowNodeConfigErrors } from '../src/workflows/registry.js';
import { workflowLayoutErrors, workflowLayoutInputSchema } from '../src/workflows/layout.js';
import { actionArgumentHash, safeActionSummary } from '../src/lib/action-safety.js';
import { workflowActionNeedsConfirmation } from '../src/policy/action-gateway.js';

describe('workflow definition validation', () => {
  it('publishes a sanitized registry backed by installed adapters', () => {
    const catalog = publicWorkflowNodeCatalog();
    expect(catalog.map((entry) => entry.type)).toEqual(expect.arrayContaining(['trigger', 'agent', 'action', 'api_action', 'mcp_action', 'knowledge_search', 'browser']));
    expect(catalog.find((entry) => entry.type === 'agent')).toMatchObject({ available: true, adapter: 'agent', risk: 'unknown' });
    expect(catalog.find((entry) => entry.type === 'mcp_action')).toMatchObject({ available: true, adapter: 'mcp', retryable: false });
    expect(catalog.find((entry) => entry.type === 'knowledge_search')).toMatchObject({ available: true, adapter: 'knowledge' });
    expect(catalog.find((entry) => entry.type === 'browser')).toMatchObject({ available: false, adapter: 'browser', risk: 'unknown', availabilityReason: expect.stringContaining('isolated') });
    expect(catalog.every((entry) => !('configSchema' in entry))).toBe(true);
  });

  it('validates registered node configuration', () => {
    expect(workflowNodeConfigErrors({ id: 'research', type: 'agent', config: {} })).toEqual(expect.arrayContaining([expect.stringContaining('agentId')]));
    expect(workflowNodeConfigErrors({ id: 'research', type: 'agent', config: { agentId: '00000000-0000-4000-8000-000000000001' } })).toEqual([]);
    expect(workflowNodeConfigErrors({ id: 'notion', type: 'mcp_action', config: { agentId: '00000000-0000-4000-8000-000000000001', mcpToolId: '00000000-0000-4000-8000-000000000002' } })).toEqual([]);
    expect(workflowNodeConfigErrors({ id: 'unsafe-retry', type: 'mcp_action', config: { agentId: '00000000-0000-4000-8000-000000000001', mcpToolId: '00000000-0000-4000-8000-000000000002', retry: { maxAttempts: 2 } } })).toEqual([expect.stringContaining('does not support automatic retries')]);
  });

  it('validates bounded editor layout without mixing it into the executable graph', () => {
    const layout = workflowLayoutInputSchema.parse({
      positions: [{ nodeId: 'start', x: 10, y: 20 }, { nodeId: 'finish', x: 400, y: 20 }],
      viewport: { x: 5, y: 6, zoom: 1.25 },
    });
    const definition = {
      nodes: [{ id: 'start', type: 'trigger' as const, config: {} }, { id: 'finish', type: 'output' as const, config: {} }],
      edges: [{ source: 'start', target: 'finish' }],
    };
    expect(layout.schemaVersion).toBe(1);
    expect(workflowLayoutErrors(layout, definition)).toEqual([]);
    expect(workflowLayoutErrors({ ...layout, positions: [{ nodeId: 'missing', x: 0, y: 0 }] }, definition)).toEqual(['Layout references unknown node missing']);
    expect(workflowLayoutInputSchema.safeParse({ positions: [{ nodeId: 'start', x: 0, y: 0 }, { nodeId: 'start', x: 1, y: 1 }] }).success).toBe(false);
  });

  it('redacts action audit data and requires confirmation for every non-read risk', () => {
    const input = { query: 'safe', apiKey: 'must-not-leak', nested: { password: 'hidden' }, value: 'sk-exampleSecret1234567890' };
    expect(safeActionSummary(input)).toEqual({ query: 'safe', apiKey: '[redacted]', nested: { password: '[redacted]' }, value: '[redacted]' });
    expect(actionArgumentHash(input)).toMatch(/^[a-f0-9]{64}$/);
    expect(actionArgumentHash({ first: 1, second: { a: true, b: false } })).toBe(actionArgumentHash({ second: { b: false, a: true }, first: 1 }));
    expect(workflowActionNeedsConfirmation('read')).toBe(false);
    for (const risk of ['write', 'external_write', 'destructive', 'unknown'] as const) expect(workflowActionNeedsConfirmation(risk)).toBe(true);
  });

  it('rejects node and loop variable names that could overwrite reserved workflow state', () => {
    expect(() => workflowLayoutInputSchema.parse({ positions: [] })).not.toThrow();
    expect(workflowDefinitionErrors({
      nodes: [{ id: 'start', type: 'trigger', config: {} }, { id: 'loop', type: 'loop', config: { mode: 'forEach', collectionPath: 'input.items', itemVariable: 'nodes', maxIterations: 2 } }, { id: 'finish', type: 'output', config: {} }],
      edges: [{ source: 'start', target: 'loop' }, { source: 'loop', target: 'finish', condition: 'done' }, { source: 'loop', target: 'loop', condition: 'body' }],
    })).toEqual(expect.arrayContaining(['Loop node loop itemVariable must be a safe non-reserved variable name']));
  });

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

  it('rejects unsafe, missing, and downstream data references', () => {
    const base = {
      nodes: [
        { id: 'start', type: 'trigger' as const, config: {} },
        { id: 'fetch', type: 'api_action' as const, config: { toolId: '00000000-0000-4000-8000-000000000001', input: { query: '{{ input.topic }}' } } },
        { id: 'send', type: 'mcp_action' as const, config: { agentId: '00000000-0000-4000-8000-000000000002', mcpToolId: '00000000-0000-4000-8000-000000000003', input: { data: '{{ nodes.fetch }}' } } },
        { id: 'finish', type: 'output' as const, config: {} },
      ],
      edges: [{ source: 'start', target: 'fetch' }, { source: 'fetch', target: 'send' }, { source: 'send', target: 'finish' }],
    };
    expect(workflowDefinitionErrors(base)).toEqual([]);
    expect(workflowDefinitionErrors({
      ...base,
      nodes: base.nodes.map((node) => node.id === 'fetch' ? { ...node, config: { ...node.config, input: { query: '{{ nodes.send.text }}', expression: '{{ input.topic + 1 }}', missing: '{{ nodes.unknown }}' } } } : node),
    })).toEqual(expect.arrayContaining([
      'Node fetch can reference only upstream node outputs (send is not upstream)',
      'Node fetch data reference input.topic + 1 is not a safe input, variables, or nodes path',
      'Node fetch data reference points to missing node unknown',
    ]));
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
