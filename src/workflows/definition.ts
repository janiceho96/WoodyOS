import { z } from 'zod';
import { workflowNodeConfigErrors, workflowNodeTypeSchema } from './registry.js';

const reservedStateKeys = new Set(['__proto__', 'prototype', 'constructor', 'nodes', 'input', 'variables', 'workflow']);
export const workflowNodeSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'Node IDs must start with a letter and contain only letters, numbers, underscores, or hyphens').refine((id) => !reservedStateKeys.has(id), 'Node ID is reserved'),
  type: workflowNodeTypeSchema,
  config: z.record(z.unknown()).default({}),
});
export const workflowEdgeSchema = z.object({ source: z.string().min(1), target: z.string().min(1), condition: z.string().max(30).optional() });
export const workflowDefinitionSchema = z.object({ nodes: z.array(workflowNodeSchema).min(2).max(200), edges: z.array(workflowEdgeSchema).max(500) });

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export type ConditionOperator = 'equals' | 'not_equals' | 'greater_than' | 'greater_or_equal' | 'less_than' | 'less_or_equal' | 'contains' | 'exists' | 'not_exists';
const conditionOperators = new Set<ConditionOperator>(['equals', 'not_equals', 'greater_than', 'greater_or_equal', 'less_than', 'less_or_equal', 'contains', 'exists', 'not_exists']);
const artifactFormats = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'html', 'md', 'txt', 'csv', 'json']);
const safePathPattern = /^(?:input|variables)(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+])*$/;
const safeNodePathPattern = /^nodes\.([A-Za-z][A-Za-z0-9_-]*)(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+])*$/;
const safeLegacyPathPattern = /^([A-Za-z_][A-Za-z0-9_-]*)(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+])*$/;

export function valueAtPath(root: unknown, path: string): unknown {
  if (!path.trim()) return undefined;
  const parts = path.replace(/\[(\d+)]/g, '.$1').split('.').filter(Boolean);
  let current = root;
  for (const part of parts) {
    if (['__proto__', 'prototype', 'constructor'].includes(part)) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
    else if (current && typeof current === 'object' && !Array.isArray(current)) current = (current as Record<string, unknown>)[part];
    else return undefined;
  }
  return current;
}

export function evaluateCondition(config: Record<string, unknown>, state: Record<string, unknown>) {
  const path = String(config.path ?? config.key ?? '');
  const operator = String(config.operator ?? 'equals') as ConditionOperator;
  const actual = valueAtPath(state, path);
  const expected = config.value ?? config.equals;
  if (operator === 'exists') return actual !== undefined && actual !== null;
  if (operator === 'not_exists') return actual === undefined || actual === null;
  if (operator === 'equals') return actual === expected;
  if (operator === 'not_equals') return actual !== expected;
  if (operator === 'contains') return typeof actual === 'string'
    ? actual.includes(String(expected ?? ''))
    : Array.isArray(actual) && actual.some((item) => item === expected);
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  if (operator === 'greater_than') return actual > expected;
  if (operator === 'greater_or_equal') return actual >= expected;
  if (operator === 'less_than') return actual < expected;
  return actual <= expected;
}

function templatePaths(value: unknown, paths: string[] = []): { paths: string[]; malformed: boolean } {
  let malformed = false;
  if (typeof value === 'string') {
    const matched: string[] = [];
    const remainder = value.replace(/\{\{\s*([^{}]+?)\s*}}/g, (_, path: string) => { matched.push(path.trim()); return ''; });
    paths.push(...matched);
    malformed ||= remainder.includes('{{') || remainder.includes('}}');
  } else if (Array.isArray(value)) {
    for (const item of value) malformed ||= templatePaths(item, paths).malformed;
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) malformed ||= templatePaths(item, paths).malformed;
  }
  return { paths, malformed };
}

function dataReferenceErrors(node: WorkflowNode, ancestors: Set<string>, known: Set<string>) {
  const errors: string[] = [];
  const values: unknown[] = [];
  if (['action', 'api_action', 'mcp_action'].includes(node.type)) values.push(node.config.input);
  if (node.type === 'agent') values.push(node.config.inputMapping);
  if (node.type === 'knowledge_search') values.push(node.config.query);
  if (node.type === 'condition') values.push(`{{ ${String(node.config.path ?? '')} }}`);
  if (node.type === 'loop') {
    if (String(node.config.mode ?? 'forEach') === 'forEach') values.push(`{{ ${String(node.config.collectionPath ?? '')} }}`);
    else if (node.config.condition && typeof node.config.condition === 'object' && !Array.isArray(node.config.condition)) values.push(`{{ ${String((node.config.condition as Record<string, unknown>).path ?? '')} }}`);
  }
  for (const value of values) {
    const references = templatePaths(value);
    if (references.malformed) errors.push(`Node ${node.id} contains malformed safe data reference syntax`);
    for (const path of references.paths) {
      const nodeMatch = path.match(safeNodePathPattern);
      const legacyMatch = path.match(safeLegacyPathPattern);
      if (!safePathPattern.test(path) && !nodeMatch && !legacyMatch) {
        errors.push(`Node ${node.id} data reference ${path || '(empty)'} is not a safe input, variables, or nodes path`);
        continue;
      }
      const referencedNodeId = nodeMatch?.[1] ?? (legacyMatch && known.has(legacyMatch[1]) ? legacyMatch[1] : null);
      if (!referencedNodeId) continue;
      if (!known.has(referencedNodeId)) errors.push(`Node ${node.id} data reference points to missing node ${referencedNodeId}`);
      else if (!ancestors.has(referencedNodeId)) errors.push(`Node ${node.id} can reference only upstream node outputs (${referencedNodeId} is not upstream)`);
    }
  }
  return errors;
}

function conditionConfigErrors(node: WorkflowNode) {
  const path = String(node.config.path ?? node.config.key ?? '');
  const operator = String(node.config.operator ?? 'equals') as ConditionOperator;
  const errors: string[] = [];
  if (!path.trim()) errors.push(`Condition node ${node.id} needs a state path`);
  if (!conditionOperators.has(operator)) errors.push(`Condition node ${node.id} uses an unsupported operator`);
  if (!['exists', 'not_exists'].includes(operator) && !('value' in node.config) && !('equals' in node.config)) errors.push(`Condition node ${node.id} needs a comparison value`);
  return errors;
}

function retryConfigErrors(node: WorkflowNode) {
  if (!('retry' in node.config)) return [];
  if (!['agent', 'action'].includes(node.type)) return [`Only agent and action nodes can define retry policies (${node.id})`];
  const retry = node.config.retry;
  if (!retry || typeof retry !== 'object' || Array.isArray(retry)) return [`Retry policy for ${node.id} must be an object`];
  const value = retry as Record<string, unknown>;
  const maxAttempts = Number(value.maxAttempts ?? 1);
  const initialDelayMs = Number(value.initialDelayMs ?? 0);
  const multiplier = Number(value.multiplier ?? 2);
  const maxDelayMs = Number(value.maxDelayMs ?? 60_000);
  const errors: string[] = [];
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) errors.push(`Retry maxAttempts for ${node.id} must be between 1 and 5`);
  if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0 || initialDelayMs > 60_000) errors.push(`Retry initialDelayMs for ${node.id} must be between 0 and 60000`);
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 4) errors.push(`Retry multiplier for ${node.id} must be between 1 and 4`);
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0 || maxDelayMs > 300_000) errors.push(`Retry maxDelayMs for ${node.id} must be between 0 and 300000`);
  return errors;
}

function loopConfigErrors(node: WorkflowNode) {
  const mode = String(node.config.mode ?? 'forEach');
  const maxIterations = Number(node.config.maxIterations ?? 10);
  const errors: string[] = [];
  if (!['forEach', 'while'].includes(mode)) errors.push(`Loop node ${node.id} mode must be forEach or while`);
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 100) errors.push(`Loop node ${node.id} maxIterations must be between 1 and 100`);
  if (!['fail', 'exit'].includes(String(node.config.onLimit ?? 'fail'))) errors.push(`Loop node ${node.id} onLimit must be fail or exit`);
  if (mode === 'forEach' && !String(node.config.collectionPath ?? '').trim()) errors.push(`For-each loop ${node.id} needs collectionPath`);
  if (mode === 'forEach') {
    for (const [field, fallback] of [['itemVariable', 'item'], ['indexVariable', 'index']] as const) {
      const value = String(node.config[field] ?? fallback);
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value) || reservedStateKeys.has(value)) errors.push(`Loop node ${node.id} ${field} must be a safe non-reserved variable name`);
    }
  }
  if (mode === 'while') {
    const condition = node.config.condition;
    if (!condition || typeof condition !== 'object' || Array.isArray(condition)) errors.push(`While loop ${node.id} needs a condition object`);
    else errors.push(...conditionConfigErrors({ ...node, config: condition as Record<string, unknown> }).map((item) => item.replace(`Condition node ${node.id}`, `While loop ${node.id}`)));
  }
  return errors;
}

export function workflowDefinitionErrors(definition: WorkflowDefinition) {
  const ids = definition.nodes.map((item) => item.id);
  const known = new Set(ids);
  const errors: string[] = [];
  const nodeById = new Map(definition.nodes.map((item) => [item.id, item]));
  if (known.size !== ids.length) errors.push('Node IDs must be unique');
  const triggers = definition.nodes.filter((item) => item.type === 'trigger');
  if (triggers.length !== 1) errors.push('A workflow requires exactly one trigger node');
  if (!definition.nodes.some((item) => item.type === 'output')) errors.push('A workflow requires at least one output node');
  if (definition.edges.some((edge) => !known.has(edge.source) || !known.has(edge.target))) errors.push('Every edge must reference an existing node');
  if (definition.edges.some((edge) => edge.source === edge.target)) errors.push('Nodes cannot connect directly to themselves');
  const outgoing = new Map(ids.map((id) => [id, definition.edges.filter((edge) => edge.source === id)]));
  const incoming = new Map(ids.map((id) => [id, definition.edges.filter((edge) => edge.target === id)]));

  for (const node of definition.nodes) {
    const edges = outgoing.get(node.id) ?? [];
    if (node.type === 'trigger' && (incoming.get(node.id)?.length ?? 0) > 0) errors.push('The trigger node cannot have incoming edges');
    if (node.type === 'trigger' && Array.isArray(node.config.inputSchema)) {
      const keys = node.config.inputSchema
        .filter((field): field is Record<string, unknown> => Boolean(field) && typeof field === 'object' && !Array.isArray(field))
        .map((field) => field.key)
        .filter((key): key is string => typeof key === 'string');
      if (new Set(keys).size !== keys.length) errors.push(`Trigger node ${node.id} inputSchema keys must be unique`);
    }
    if (node.type === 'output' && edges.length) errors.push(`Output node ${node.id} cannot have outgoing edges`);
    if (!['condition', 'loop', 'output'].includes(node.type) && edges.length !== 1) errors.push(`${node.type} node ${node.id} needs exactly one outgoing edge`);
    if (node.type === 'condition') {
      if (edges.length !== 2 || !edges.some((edge) => edge.condition === 'true') || !edges.some((edge) => edge.condition === 'false') || edges.some((edge) => !['true', 'false'].includes(edge.condition ?? ''))) errors.push(`Condition node ${node.id} needs exactly one true and one false edge`);
      errors.push(...conditionConfigErrors(node));
    }
    if (node.type === 'loop') {
      if (edges.length !== 2 || !edges.some((edge) => edge.condition === 'body') || !edges.some((edge) => edge.condition === 'done') || edges.some((edge) => !['body', 'done'].includes(edge.condition ?? ''))) errors.push(`Loop node ${node.id} needs exactly one body and one done edge`);
      errors.push(...loopConfigErrors(node));
    }
    if (node.type === 'output') {
      const fromNodeId = node.config.fromNodeId;
      if (fromNodeId !== undefined && (typeof fromNodeId !== 'string' || !known.has(fromNodeId) || fromNodeId === node.id)) errors.push(`Output node ${node.id} has an invalid fromNodeId`);
      const formats = node.config.artifactFormats;
      if (formats !== undefined && (!Array.isArray(formats) || formats.some((format) => typeof format !== 'string' || !artifactFormats.has(format)) || new Set(formats).size !== formats.length)) errors.push(`Output node ${node.id} artifactFormats must contain unique supported file formats`);
    }
    errors.push(...workflowNodeConfigErrors(node));
    errors.push(...retryConfigErrors(node));
  }

  if (known.size === ids.length && definition.edges.every((edge) => known.has(edge.source) && known.has(edge.target))) {
    for (const node of definition.nodes) {
      const ancestors = new Set<string>();
      const pending = definition.edges.filter((edge) => edge.target === node.id).map((edge) => edge.source);
      while (pending.length) {
        const id = pending.pop()!;
        if (ancestors.has(id)) continue;
        ancestors.add(id);
        for (const edge of definition.edges) if (edge.target === id && !ancestors.has(edge.source)) pending.push(edge.source);
      }
      errors.push(...dataReferenceErrors(node, ancestors, known));
    }
  }

  for (const edge of definition.edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    if (edge.condition === 'continue') {
      if (target.type !== 'loop') errors.push(`Continue edge ${edge.source} → ${edge.target} must target a loop node`);
      if (source.type === 'condition' || source.type === 'loop' || source.type === 'output') errors.push(`Continue edge cannot start from ${source.type} node ${source.id}`);
    } else if (source.type === 'condition' && !['true', 'false'].includes(edge.condition ?? '')) errors.push(`Condition edge from ${source.id} must be true or false`);
    else if (source.type === 'loop' && !['body', 'done'].includes(edge.condition ?? '')) errors.push(`Loop edge from ${source.id} must be body or done`);
    else if (!['condition', 'loop'].includes(source.type) && edge.condition) errors.push(`Edge condition ${edge.condition} is not valid from ${source.type} node ${source.id}`);
  }

  if (known.size === ids.length && definition.edges.every((edge) => known.has(edge.source) && known.has(edge.target))) {
    const trigger = triggers[0];
    if (trigger) {
      const reachable = new Set([trigger.id]);
      const pending = [trigger.id];
      while (pending.length) {
        const id = pending.pop()!;
        for (const edge of outgoing.get(id) ?? []) if (!reachable.has(edge.target)) { reachable.add(edge.target); pending.push(edge.target); }
      }
      if (reachable.size !== known.size) errors.push('Every node must be reachable from the trigger node');
    }
    const nonLoopOutgoing = new Map(ids.map((id) => [id, (outgoing.get(id) ?? []).filter((edge) => edge.condition !== 'continue')]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycle = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      const cyclic = (nonLoopOutgoing.get(id) ?? []).some((edge) => hasCycle(edge.target));
      visiting.delete(id); visited.add(id);
      return cyclic;
    };
    if (ids.some(hasCycle)) errors.push('Workflow cycles are allowed only through continue edges back to loop nodes');
    for (const loop of definition.nodes.filter((item) => item.type === 'loop')) {
      const body = (outgoing.get(loop.id) ?? []).find((edge) => edge.condition === 'body')?.target;
      if (!body) continue;
      const bodyReachable = new Set([body]);
      const pending = [body];
      while (pending.length) {
        const id = pending.pop()!;
        for (const edge of nonLoopOutgoing.get(id) ?? []) if (!bodyReachable.has(edge.target)) { bodyReachable.add(edge.target); pending.push(edge.target); }
      }
      const returns = definition.edges.some((edge) => edge.condition === 'continue' && edge.target === loop.id && bodyReachable.has(edge.source));
      if (!returns) errors.push(`Loop node ${loop.id} body needs a reachable continue edge back to the loop`);
    }
  }
  return [...new Set(errors)];
}

export function retryPolicy(node: WorkflowNode) {
  const raw = node.config.retry && typeof node.config.retry === 'object' && !Array.isArray(node.config.retry) ? node.config.retry as Record<string, unknown> : {};
  return {
    maxAttempts: Math.min(5, Math.max(1, Math.round(Number(raw.maxAttempts ?? 1)))),
    initialDelayMs: Math.min(60_000, Math.max(0, Number(raw.initialDelayMs ?? 0))),
    multiplier: Math.min(4, Math.max(1, Number(raw.multiplier ?? 2))),
    maxDelayMs: Math.min(300_000, Math.max(0, Number(raw.maxDelayMs ?? 60_000))),
  };
}
