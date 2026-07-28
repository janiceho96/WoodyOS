import { performance } from 'node:perf_hooks';
import { runtimeError } from '../runtime/errors.js';
import { evaluateCondition, type WorkflowDefinition, type WorkflowNode, valueAtPath } from './definition.js';
import { resolveWorkflowTemplates } from './adapters/templates.js';
import { loopResult } from './adapters/logic.js';

export type EvaluationAssertion =
  | { kind: 'output.json_path'; path: string; operator: 'equals' | 'contains'; expected: unknown }
  | { kind: 'output.schema'; schema: Record<string, unknown> }
  | { kind: 'cost_usd'; operator: '<='; expected: number }
  | { kind: 'duration_ms'; operator: '<='; expected: number }
  | { kind: 'quality.score'; operator: '>='; expected: number };

export type EvaluationAssertionResult = {
  index: number;
  kind: EvaluationAssertion['kind'];
  passed: boolean;
  actual: unknown;
  expected?: unknown;
  message?: string;
};

export type EvaluationMeasurements = {
  costUsd: number;
  durationMs: number;
  qualityScore: number | null;
};

type ModelResult = { output: unknown; costUsd?: number; qualityScore?: number };

export type FixtureEvaluationInput = {
  definition: WorkflowDefinition;
  input: Record<string, unknown>;
  fixtures: Record<string, unknown>;
  assertions: unknown;
  measurements?: Partial<EvaluationMeasurements>;
  executeModel?: (input: { node: WorkflowNode; state: Record<string, unknown> }) => Promise<ModelResult>;
  /** Test sentinel: evaluation never invokes this callback. */
  liveAction?: () => unknown;
};

export type FixtureEvaluationResult = {
  status: 'passed' | 'failed';
  output: unknown;
  assertionResults: EvaluationAssertionResult[];
  measurements: EvaluationMeasurements;
};

const externalNodeAdapters: Partial<Record<WorkflowNode['type'], 'api' | 'mcp' | 'browser' | 'file'>> = {
  action: 'api',
  api_action: 'api',
  mcp_action: 'mcp',
  browser: 'browser',
  knowledge_search: 'file',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function evaluationError(code: string, message: string, details?: unknown) {
  return runtimeError(code, { category: 'validation', retryable: false, message, details });
}

export function evaluationFixtureKey(adapter: 'api' | 'mcp' | 'browser' | 'file', resourceId: string, operation: string) {
  if (!adapter || !resourceId.trim() || !operation.trim()) throw evaluationError('EVALUATION_FIXTURE_IDENTITY_INVALID', 'Evaluation fixtures need an adapter, resource identity, and operation');
  return `${adapter}:${resourceId}:${operation}`;
}

function externalIdentity(node: WorkflowNode) {
  const adapter = externalNodeAdapters[node.type]
    ?? (node.config.sourceType === 'file' ? 'file' : null);
  if (!adapter) return null;
  const resourceId = adapter === 'mcp'
    ? node.config.mcpToolId
    : adapter === 'file'
      ? node.config.fileId ?? node.config.documentId ?? node.config.sourceId ?? 'workspace-knowledge'
      : adapter === 'browser'
        ? node.config.browserId ?? node.config.url
        : node.config.toolId;
  const operation = node.config.operation ?? (adapter === 'browser' ? 'navigate' : adapter === 'file' ? 'read' : 'default');
  if (typeof resourceId !== 'string' || typeof operation !== 'string') {
    throw evaluationError('EVALUATION_FIXTURE_IDENTITY_INVALID', `External node ${node.id} has no stable fixture identity`, { nodeId: node.id, adapter });
  }
  return { adapter, resourceId, operation, key: evaluationFixtureKey(adapter, resourceId, operation) };
}

function assertionError(message: string, details?: unknown): never {
  throw evaluationError('EVALUATION_ASSERTION_INVALID', message, details);
}

function validJsonPath(path: unknown) {
  return typeof path === 'string'
    && /^(?:[A-Za-z_][A-Za-z0-9_-]*)(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+\])*$/.test(path);
}

export function validateRegressionAssertions(value: unknown): EvaluationAssertion[] {
  if (!Array.isArray(value) || value.length > 100) assertionError('Regression assertions must be an array of at most 100 assertions');
  return value.map((raw, index) => {
    const assertion = asRecord(raw);
    if (!assertion) assertionError('Regression assertions must be objects', { index });
    const kind = assertion?.kind;
    if (kind === 'output.json_path') {
      if (!validJsonPath(assertion.path) || !['equals', 'contains'].includes(String(assertion.operator))) assertionError('Output assertions need a safe JSON path and equals or contains operator', { index });
      if (!('expected' in assertion)) assertionError('Output assertions need an expected value', { index });
      return { kind, path: String(assertion.path), operator: assertion.operator as 'equals' | 'contains', expected: assertion.expected };
    }
    if (kind === 'output.schema') {
      if (!asRecord(assertion.schema)) assertionError('Schema assertions need a JSON schema object', { index });
      return { kind, schema: assertion.schema as Record<string, unknown> };
    }
    if (kind === 'cost_usd' || kind === 'duration_ms' || kind === 'quality.score') {
      const expected = assertion.expected;
      const operator = kind === 'quality.score' ? '>=' : '<=';
      if (assertion.operator !== operator || typeof expected !== 'number' || !Number.isFinite(expected) || expected < 0) assertionError(`${kind} assertions need a non-negative ${operator} numeric threshold`, { index });
      return { kind, operator, expected } as EvaluationAssertion;
    }
    assertionError('Regression assertion kind is unsupported', { index, kind });
  });
}

function jsonEquals(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function conforms(value: unknown, schema: Record<string, unknown>): boolean {
  const type = schema.type;
  if (type === 'object') {
    const object = asRecord(value); if (!object) return false;
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some((key) => typeof key !== 'string' || !(key in object))) return false;
    const properties = asRecord(schema.properties) ?? {};
    return Object.entries(properties).every(([key, child]) => !Object.hasOwn(object, key) || (asRecord(child) ? conforms(object[key], asRecord(child)!) : false));
  }
  if (type === 'array') return Array.isArray(value) && (!schema.items || (asRecord(schema.items) ? value.every((item) => conforms(item, schema.items as Record<string, unknown>)) : false));
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return type === undefined || type === 'any';
}

export function evaluateRegressionAssertions(output: unknown, measurements: EvaluationMeasurements, assertions: EvaluationAssertion[]): EvaluationAssertionResult[] {
  return assertions.map((assertion, index) => {
    if (assertion.kind === 'output.json_path') {
      const actual = valueAtPath(output, assertion.path);
      const passed = assertion.operator === 'equals'
        ? jsonEquals(actual, assertion.expected)
        : typeof actual === 'string' ? actual.includes(String(assertion.expected)) : Array.isArray(actual) && actual.some((item) => jsonEquals(item, assertion.expected));
      return { index, kind: assertion.kind, passed, actual, expected: assertion.expected };
    }
    if (assertion.kind === 'output.schema') return { index, kind: assertion.kind, passed: conforms(output, assertion.schema), actual: output, expected: assertion.schema };
    if (assertion.kind === 'cost_usd') return { index, kind: assertion.kind, passed: measurements.costUsd <= assertion.expected, actual: measurements.costUsd, expected: assertion.expected };
    if (assertion.kind === 'duration_ms') return { index, kind: assertion.kind, passed: measurements.durationMs <= assertion.expected, actual: measurements.durationMs, expected: assertion.expected };
    const actual = measurements.qualityScore;
    return { index, kind: assertion.kind, passed: actual !== null && actual >= assertion.expected, actual, expected: assertion.expected };
  });
}

function nextEdge(definition: WorkflowDefinition, node: WorkflowNode, branch?: string) {
  const edges = definition.edges.filter((edge) => edge.source === node.id);
  return edges.find((edge) => edge.condition === branch) ?? (branch === undefined ? edges.find((edge) => !edge.condition) ?? edges[0] : undefined);
}

export async function runFixtureEvaluation(input: FixtureEvaluationInput): Promise<FixtureEvaluationResult> {
  const assertions = validateRegressionAssertions(input.assertions);
  const state: Record<string, unknown> = { input: structuredClone(input.input), nodes: {}, variables: {} };
  const nodes = new Map(input.definition.nodes.map((node) => [node.id, node]));
  const loops: Record<string, { iteration: number }> = {};
  let current = input.definition.nodes.find((node) => node.type === 'trigger');
  if (!current) throw evaluationError('EVALUATION_TRIGGER_REQUIRED', 'Evaluation requires a trigger node');
  let output: unknown = state;
  let costUsd = input.measurements?.costUsd ?? 0;
  let qualityScore = input.measurements?.qualityScore ?? null;
  const started = performance.now();
  const maxSteps = Math.max(1, input.definition.nodes.length * 20);

  for (let step = 0; current && step < maxSteps; step += 1) {
    let nodeOutput: unknown = null;
    let branch: string | undefined;
    const identity = externalIdentity(current);
    if (identity) {
      if (!Object.hasOwn(input.fixtures, identity.key)) throw evaluationError('EVALUATION_FIXTURE_REQUIRED', `Fixture ${identity.key} is required for ${current.id}`, { nodeId: current.id, fixtureKey: identity.key });
      nodeOutput = structuredClone(input.fixtures[identity.key]);
    } else if (current.type === 'agent') {
      if (!input.executeModel) throw evaluationError('EVALUATION_MODEL_EXECUTOR_REQUIRED', `Evaluation needs a pinned model executor for agent node ${current.id}`, { nodeId: current.id });
      const model = await input.executeModel({ node: current, state });
      nodeOutput = model.output;
      costUsd += Number.isFinite(model.costUsd) ? Number(model.costUsd) : 0;
      if (typeof model.qualityScore === 'number' && Number.isFinite(model.qualityScore)) qualityScore = model.qualityScore;
    } else if (current.type === 'condition') {
      branch = evaluateCondition(current.config, state) ? 'true' : 'false';
      nodeOutput = { result: branch === 'true' };
    } else if (current.type === 'loop') {
      const result = loopResult(current, { nodeId: current.id, loops, attempt: 1 }, state);
      branch = result.branch;
      nodeOutput = result.output;
    } else if (current.type === 'approval') {
      nodeOutput = { approved: true, mode: 'evaluation' };
    } else if (current.type === 'output') {
      if (asRecord(current.config.output)) Object.assign(state, current.config.output);
      const fromNodeId = current.config.fromNodeId;
      output = typeof fromNodeId === 'string' ? state[fromNodeId] : state;
      if (typeof fromNodeId === 'string' && !(fromNodeId in state)) throw evaluationError('EVALUATION_OUTPUT_UNAVAILABLE', `Output node ${current.id} references unavailable result ${fromNodeId}`);
      const durationMs = input.measurements?.durationMs ?? Math.round(performance.now() - started);
      const measurements = { costUsd, durationMs, qualityScore };
      const assertionResults = evaluateRegressionAssertions(output, measurements, assertions);
      return { status: assertionResults.every((result) => result.passed) ? 'passed' : 'failed', output, assertionResults, measurements };
    }

    state[current.id] = nodeOutput;
    (state.nodes as Record<string, unknown>)[current.id] = nodeOutput;
    const edge = nextEdge(input.definition, current, branch);
    if (edge?.condition === 'continue') {
      const loop = loops[edge.target];
      if (!loop) throw evaluationError('EVALUATION_LOOP_CURSOR_INVALID', `Continue edge returned to inactive loop ${edge.target}`, { nodeId: current.id });
      loops[edge.target] = { iteration: loop.iteration + 1 };
    }
    if (current.type === 'loop' && branch === 'done') delete loops[current.id];
    current = edge ? nodes.get(edge.target) : undefined;
  }
  throw evaluationError('EVALUATION_PATH_INVALID', 'Evaluation did not reach an output node');
}
