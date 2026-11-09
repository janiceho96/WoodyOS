import { performance } from 'node:perf_hooks';
import { assertManifestCompatible, canonicalJson, type ExecutionManifest } from '../runtime/manifest.js';
import { runtimeError } from '../runtime/errors.js';
import { evaluateCondition, type WorkflowDefinition, type WorkflowNode, valueAtPath } from './definition.js';
import { resolveNodeInput, resolveWorkflowTemplates } from './adapters/templates.js';
import { loopResult } from './adapters/logic.js';
import { workflowContractErrors } from './contracts.js';
import { advanceWorkflowCursor, WORKFLOW_STEP_LIMIT } from './traversal.js';
import type { WorkflowCursor } from './adapters/types.js';

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
  manifest: ExecutionManifest;
  input: Record<string, unknown>;
  fixtures: Record<string, unknown>;
  assertions: unknown;
  measurements?: Partial<EvaluationMeasurements>;
  executeModel?: (input: { node: WorkflowNode; state: Record<string, unknown> }) => Promise<ModelResult>;
};

export type FixtureEvaluationResult = {
  status: 'passed' | 'failed';
  output: unknown;
  assertionResults: EvaluationAssertionResult[];
  measurements: EvaluationMeasurements;
};

const externalNodeAdapters: Partial<Record<WorkflowNode['type'], 'api' | 'mcp' | 'file'>> = {
  action: 'api',
  api_action: 'api',
  mcp_action: 'mcp',
  knowledge_search: 'file',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function evaluationError(code: string, message: string, details?: unknown) {
  return runtimeError(code, { category: 'validation', retryable: false, message, details });
}

export function evaluationFixtureKey(adapter: 'api' | 'mcp' | 'browser' | 'file' | 'approval', resourceId: string, operation: string) {
  if (!adapter || !resourceId.trim() || !operation.trim()) throw evaluationError('EVALUATION_FIXTURE_IDENTITY_INVALID', 'Evaluation fixtures need an adapter, resource identity, and operation');
  return `${adapter}:${resourceId}:${operation}`;
}

function externalIdentity(node: WorkflowNode, manifest: ExecutionManifest) {
  const adapter = externalNodeAdapters[node.type];
  if (!adapter) return null;
  const resourceId = adapter === 'mcp'
    ? node.config.mcpToolId
    : adapter === 'file'
      ? node.config.fileId ?? node.config.documentId ?? node.config.sourceId ?? 'workspace-knowledge'
      : node.config.toolId;
  const operation = adapter === 'file' ? 'read' : 'invoke';
  if (typeof resourceId !== 'string' || typeof operation !== 'string') {
    throw evaluationError('EVALUATION_FIXTURE_IDENTITY_INVALID', `External node ${node.id} has no stable fixture identity`, { nodeId: node.id, adapter });
  }
  if (adapter === 'api' && manifest.apiTools[resourceId]?.toolId !== resourceId) {
    throw evaluationError('EVALUATION_MANIFEST_RESOURCE_MISSING', `Pinned manifest does not authorize API resource ${resourceId}`, { nodeId: node.id, resourceId });
  }
  if (adapter === 'mcp' && manifest.mcpActions[resourceId]?.toolId !== resourceId) {
    throw evaluationError('EVALUATION_MANIFEST_RESOURCE_MISSING', `Pinned manifest does not authorize MCP resource ${resourceId}`, { nodeId: node.id, resourceId });
  }
  return { adapter, resourceId, operation, key: evaluationFixtureKey(adapter, resourceId, operation) };
}

export function validateEvaluationFixtures(fixtures: Record<string, unknown>) {
  for (const [key, fixture] of Object.entries(fixtures)) {
    if (!key.startsWith('approval:')) continue;
    if (!/^approval:[A-Za-z][A-Za-z0-9_-]*:decision$/.test(key)) {
      throw evaluationError('EVALUATION_FIXTURE_KEY_INVALID', 'Approval fixtures need an exact approval:<nodeId>:decision key', { fixtureKey: key });
    }
    const value = asRecord(fixture);
    if (!value || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'decision') || !['approved', 'rejected'].includes(String(value.decision)) && typeof value.decision !== 'boolean') {
      throw evaluationError('EVALUATION_APPROVAL_FIXTURE_INVALID', 'Approval fixture decisions must be approved, rejected, true, or false', { fixtureKey: key });
    }
  }
  return fixtures;
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
      return { kind, schema: validateSchema(assertion.schema as Record<string, unknown>) };
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
  return canonicalJson(left) === canonicalJson(right);
}

const schemaKeys = new Set(['type', 'properties', 'required', 'items', 'nullable']);

function validateSchema(schema: Record<string, unknown>, path = 'schema'): Record<string, unknown> {
  for (const key of Object.keys(schema)) if (!schemaKeys.has(key)) assertionError(`Unsupported JSON Schema keyword ${key}`, { path, key });
  if (schema.type !== undefined && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null', 'any'].includes(String(schema.type))) assertionError('Schema type is unsupported', { path, type: schema.type });
  if (schema.nullable !== undefined && typeof schema.nullable !== 'boolean') assertionError('Schema nullable must be boolean', { path });
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string' || !key.trim()))) assertionError('Schema required must be an array of property names', { path });
  if (schema.properties !== undefined) {
    const properties = asRecord(schema.properties); if (!properties) assertionError('Schema properties must be an object', { path });
    for (const [key, child] of Object.entries(properties)) {
      const childSchema = asRecord(child); if (!childSchema) assertionError('Schema property must be an object', { path: `${path}.properties.${key}` });
      validateSchema(childSchema, `${path}.properties.${key}`);
    }
  }
  if (schema.items !== undefined) {
    const itemSchema = asRecord(schema.items); if (!itemSchema) assertionError('Schema items must be an object', { path });
    validateSchema(itemSchema, `${path}.items`);
  }
  return schema;
}

function jsonContains(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string' && typeof expected === 'string') return actual.includes(expected);
  if (!Array.isArray(actual) && !Array.isArray(expected) && !asRecord(actual) && !asRecord(expected)) return jsonEquals(actual, expected);
  if (Array.isArray(actual)) return Array.isArray(expected)
    ? expected.every((item) => actual.some((candidate) => jsonContains(candidate, item)))
    : actual.some((candidate) => jsonContains(candidate, expected));
  const actualObject = asRecord(actual); const expectedObject = asRecord(expected);
  return Boolean(actualObject && expectedObject && Object.entries(expectedObject).every(([key, value]) => Object.hasOwn(actualObject, key) && jsonContains(actualObject[key], value)));
}

function externalFixtureInput(node: WorkflowNode, state: Record<string, unknown>) {
  if (node.type === 'knowledge_search') {
    const resolved = resolveWorkflowTemplates(node.config.query, state);
    const query = typeof resolved === 'string' ? resolved.trim() : JSON.stringify(resolved);
    if (!query || query.length < 2) throw evaluationError('EVALUATION_KNOWLEDGE_QUERY_INVALID', `Knowledge search ${node.id} resolved to an empty query`, { nodeId: node.id });
    return { query, limit: Math.min(20, Math.max(1, Number(node.config.limit ?? 8))) };
  }
  const configured = asRecord(node.config.input);
  const fallback = node.type === 'mcp_action' ? {} : state;
  return resolveWorkflowTemplates(configured ?? fallback, state);
}

function knowledgeFixtureOutput(fixture: unknown, input: unknown, nodeId: string, fixtureKey: string) {
  const record = asRecord(fixture);
  const allowedKeys = new Set(['expectedInput', 'results']);
  if (!record || !Array.isArray(record.results) || Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw evaluationError('EVALUATION_KNOWLEDGE_FIXTURE_INVALID', `Fixture ${fixtureKey} must contain knowledge results`, { nodeId, fixtureKey });
  }
  const request = asRecord(input);
  if (!request || typeof request.query !== 'string' || typeof request.limit !== 'number') {
    throw evaluationError('EVALUATION_KNOWLEDGE_FIXTURE_INVALID', `Knowledge input for ${nodeId} is invalid`, { nodeId, fixtureKey });
  }
  return { query: request.query, count: record.results.length, results: record.results };
}

function approvalDecision(fixture: unknown, nodeId: string) {
  const key = evaluationFixtureKey('approval', nodeId, 'decision');
  const record = asRecord(fixture);
  if (!record) throw evaluationError('EVALUATION_APPROVAL_FIXTURE_REQUIRED', `Fixture ${key} is required for approval node ${nodeId}`, { nodeId, fixtureKey: key });
  const decision = record.decision;
  if (decision === 'approved' || decision === true) return true;
  if (decision === 'rejected' || decision === false) return false;
  throw evaluationError('EVALUATION_APPROVAL_FIXTURE_INVALID', `Fixture ${key} has an invalid approval decision`, { nodeId, fixtureKey: key });
}

function conforms(value: unknown, schema: Record<string, unknown>): boolean {
  if (value === null && schema.nullable === true) return true;
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
        : jsonContains(actual, assertion.expected);
      return { index, kind: assertion.kind, passed, actual, expected: assertion.expected };
    }
    if (assertion.kind === 'output.schema') return { index, kind: assertion.kind, passed: conforms(output, assertion.schema), actual: output, expected: assertion.schema };
    if (assertion.kind === 'cost_usd') return { index, kind: assertion.kind, passed: measurements.costUsd <= assertion.expected, actual: measurements.costUsd, expected: assertion.expected };
    if (assertion.kind === 'duration_ms') return { index, kind: assertion.kind, passed: measurements.durationMs <= assertion.expected, actual: measurements.durationMs, expected: assertion.expected };
    const actual = measurements.qualityScore;
    return { index, kind: assertion.kind, passed: actual !== null && actual >= assertion.expected, actual, expected: assertion.expected };
  });
}

type FixtureNodeResult =
  | { kind: 'continue'; output: unknown; result: unknown; costDelta?: number; qualityScore?: number }
  | { kind: 'finish'; output: unknown };

type FixtureNodeContext = {
  input: FixtureEvaluationInput;
  manifest: ExecutionManifest;
  state: Record<string, unknown>;
  cursor: WorkflowCursor;
};

function fixtureTriggerResult(context: FixtureNodeContext): FixtureNodeResult {
  return { kind: 'continue', output: context.state.input, result: context.state.input };
}

function fixtureExternalResult(node: WorkflowNode, identity: NonNullable<ReturnType<typeof externalIdentity>>, context: FixtureNodeContext): FixtureNodeResult {
  const { input, manifest, state } = context;
  if (!Object.hasOwn(input.fixtures, identity.key)) {
    throw evaluationError('EVALUATION_FIXTURE_REQUIRED', `Fixture ${identity.key} is required for ${node.id}`, { nodeId: node.id, fixtureKey: identity.key });
  }
  const resolvedInput = externalFixtureInput(node, state);
  const fixture = structuredClone(input.fixtures[identity.key]);
  const fixtureRecord = asRecord(fixture);
  if (fixtureRecord && Object.hasOwn(fixtureRecord, 'expectedInput') && !jsonEquals(fixtureRecord.expectedInput, resolvedInput)) {
    throw evaluationError('EVALUATION_FIXTURE_INPUT_MISMATCH', `Fixture ${identity.key} does not match resolved node input`, { nodeId: node.id, fixtureKey: identity.key });
  }
  const output = node.type === 'knowledge_search'
    ? knowledgeFixtureOutput(fixture, resolvedInput, node.id, identity.key)
    : fixtureRecord && Object.hasOwn(fixtureRecord, 'output') ? fixtureRecord.output : fixture;
  return { kind: 'continue', output, result: output };
}

async function fixtureAgentResult(node: WorkflowNode, context: FixtureNodeContext): Promise<FixtureNodeResult> {
  const { input, manifest, state } = context;
  if (!input.executeModel) throw evaluationError('EVALUATION_MODEL_EXECUTOR_REQUIRED', `Evaluation needs a pinned model executor for agent node ${node.id}`, { nodeId: node.id });
  const agentId = node.config.agentId;
  if (typeof agentId !== 'string' || !manifest.agents[agentId]) {
    throw evaluationError('EVALUATION_MANIFEST_RESOURCE_MISSING', `Pinned manifest does not authorize agent ${String(agentId)}`, { nodeId: node.id });
  }
  const mappedInput = resolveNodeInput(asRecord(node.config.inputMapping) ?? undefined, state);
  const model = await input.executeModel({ node: { ...node, config: { ...node.config, input: mappedInput } }, state });
  return {
    kind: 'continue',
    output: model.output,
    result: model.output,
    costDelta: Number.isFinite(model.costUsd) ? Number(model.costUsd) : 0,
    ...(typeof model.qualityScore === 'number' && Number.isFinite(model.qualityScore) ? { qualityScore: model.qualityScore } : {}),
  };
}

function fixtureApprovalResult(node: WorkflowNode, context: FixtureNodeContext): FixtureNodeResult {
  const key = evaluationFixtureKey('approval', node.id, 'decision');
  if (!Object.hasOwn(context.input.fixtures, key)) {
    throw evaluationError('EVALUATION_APPROVAL_FIXTURE_REQUIRED', `Fixture ${key} is required for approval node ${node.id}`, { nodeId: node.id, fixtureKey: key });
  }
  if (!approvalDecision(context.input.fixtures[key], node.id)) {
    throw evaluationError('EVALUATION_APPROVAL_REJECTED', `Approval fixture rejected node ${node.id}`, { nodeId: node.id, fixtureKey: key });
  }
  const output = { approved: true, mode: 'evaluation' };
  return { kind: 'continue', output, result: output };
}

function fixtureOutputResult(node: WorkflowNode, state: Record<string, unknown>): FixtureNodeResult {
  if (asRecord(node.config.output)) Object.assign(state, node.config.output);
  const fromNodeId = node.config.fromNodeId;
  if (typeof fromNodeId === 'string' && !(fromNodeId in state)) {
    throw evaluationError('EVALUATION_OUTPUT_UNAVAILABLE', `Output node ${node.id} references unavailable result ${fromNodeId}`);
  }
  return { kind: 'finish', output: typeof fromNodeId === 'string' ? state[fromNodeId] : state };
}

async function evaluateFixtureNode(node: WorkflowNode, context: FixtureNodeContext): Promise<FixtureNodeResult> {
  if (node.type === 'trigger') return fixtureTriggerResult(context);
  const identity = externalIdentity(node, context.manifest);
  if (identity) return fixtureExternalResult(node, identity, context);

  if (node.type === 'agent') return fixtureAgentResult(node, context);
  if (node.type === 'condition') {
    const result = evaluateCondition(node.config, context.state);
    return { kind: 'continue', output: result, result };
  }
  if (node.type === 'loop') {
    const loop = loopResult(node, context.cursor, context.state);
    return { kind: 'continue', output: loop.output, result: loop.branch };
  }
  if (node.type === 'approval') return fixtureApprovalResult(node, context);
  if (node.type === 'output') return fixtureOutputResult(node, context.state);
  throw evaluationError('EVALUATION_NODE_UNSUPPORTED', `Evaluation does not support node type ${node.type}`, { nodeId: node.id, type: node.type });
}

export async function runFixtureEvaluation(input: FixtureEvaluationInput): Promise<FixtureEvaluationResult> {
  const assertions = validateRegressionAssertions(input.assertions);
  validateEvaluationFixtures(input.fixtures);
  const manifest = assertManifestCompatible(input.manifest);
  const contractErrors = workflowContractErrors(input.definition);
  if (contractErrors.length) throw evaluationError('EVALUATION_CONTRACT_INVALID', 'Workflow contracts are invalid for evaluation', { errors: contractErrors });
  const runtimeInput = structuredClone(input.input);
  const state: Record<string, unknown> = {
    ...runtimeInput,
    input: runtimeInput,
    nodes: {},
    variables: {},
    __runtime: { agentExecutionIdentitySchemaVersion: 1 },
  };
  const nodes = new Map(input.definition.nodes.map((node) => [node.id, node]));
  let cursor: WorkflowCursor | null = (() => {
    const trigger = input.definition.nodes.find((node) => node.type === 'trigger');
    return trigger ? { nodeId: trigger.id, loops: {}, attempt: 1 } : null;
  })();
  let current = cursor ? nodes.get(cursor.nodeId) : undefined;
  if (!current) throw evaluationError('EVALUATION_TRIGGER_REQUIRED', 'Evaluation requires a trigger node');
  let output: unknown = state;
  let costUsd = input.measurements?.costUsd ?? 0;
  let qualityScore = input.measurements?.qualityScore ?? null;
  const started = performance.now();

  for (let step = 0; current && cursor && step <= WORKFLOW_STEP_LIMIT; step += 1) {
    const evaluated = await evaluateFixtureNode(current, { input, manifest, state, cursor });
    if (evaluated.kind === 'finish') {
      output = evaluated.output;
      const durationMs = input.measurements?.durationMs ?? Math.round(performance.now() - started);
      const measurements = { costUsd, durationMs, qualityScore };
      const assertionResults = evaluateRegressionAssertions(output, measurements, assertions);
      return { status: assertionResults.every((result) => result.passed) ? 'passed' : 'failed', output, assertionResults, measurements };
    }

    if (current.type !== 'trigger') {
      state[current.id] = evaluated.output;
      (state.nodes as Record<string, unknown>)[current.id] = evaluated.output;
    }
    costUsd += evaluated.costDelta ?? 0;
    if (evaluated.qualityScore !== undefined) qualityScore = evaluated.qualityScore;
    const advanced = advanceWorkflowCursor(input.definition, cursor, current, evaluated.result);
    if (!advanced) throw evaluationError('EVALUATION_PATH_INVALID', `Node ${current.id} did not resolve an outgoing edge`, { nodeId: current.id });
    cursor = advanced.cursor;
    current = nodes.get(cursor.nodeId);
  }
  throw evaluationError('EVALUATION_STEP_LIMIT_EXCEEDED', `Workflow exceeded the ${WORKFLOW_STEP_LIMIT}-step safety limit`);
}
