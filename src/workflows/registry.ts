import { z } from 'zod';

export const workflowNodeTypes = [
  'trigger',
  'agent',
  'action',
  'condition',
  'approval',
  'loop',
  'output',
  'api_action',
  'mcp_action',
  'knowledge_search',
  'browser',
] as const;

export const workflowNodeTypeSchema = z.enum(workflowNodeTypes);
export type WorkflowNodeType = z.infer<typeof workflowNodeTypeSchema>;

export type WorkflowNodeCategory = 'trigger' | 'ai' | 'integration' | 'knowledge' | 'logic' | 'human' | 'output';
export type WorkflowNodeRisk = 'read' | 'write' | 'external_write' | 'destructive' | 'unknown';
export type WorkflowNodeAdapter = 'logic' | 'agent' | 'legacy_tool' | 'api' | 'mcp' | 'knowledge' | 'file' | 'browser';
export type WorkflowPort = {
  id: string;
  label: string;
  dataType: 'any' | 'boolean' | 'object' | 'text' | 'collection' | 'file';
  required?: boolean;
};
export type WorkflowConfigField = {
  key: string;
  label: string;
  control: 'text' | 'textarea' | 'number' | 'select' | 'json' | 'resource' | 'multiselect';
  required?: boolean;
  resource?: 'agent' | 'api_tool' | 'mcp_tool' | 'node';
  options?: Array<{ value: string; label: string }>;
  help?: string;
};

type RegistryEntry = {
  type: WorkflowNodeType;
  category: WorkflowNodeCategory;
  title: string;
  description: string;
  icon: string;
  adapter: WorkflowNodeAdapter;
  risk: WorkflowNodeRisk;
  available: boolean;
  availabilityReason?: string;
  retryable: boolean;
  inputPorts: WorkflowPort[];
  outputPorts: WorkflowPort[];
  configFields: WorkflowConfigField[];
  configSchema: z.ZodType<Record<string, unknown>>;
};

const retrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(5).optional(),
  initialDelayMs: z.number().min(0).max(60_000).optional(),
  multiplier: z.number().min(1).max(4).optional(),
  maxDelayMs: z.number().min(0).max(300_000).optional(),
}).passthrough();

const recordSchema = z.record(z.unknown());
const normalInput: WorkflowPort[] = [{ id: 'input', label: 'Input', dataType: 'any' }];
const normalOutput: WorkflowPort[] = [{ id: 'output', label: 'Output', dataType: 'any' }];

const entries = [
  {
    type: 'trigger', category: 'trigger', title: 'Manual trigger', description: 'Starts a workflow with input provided by the user or API.', icon: 'zap', adapter: 'logic', risk: 'read', available: true, retryable: false,
    inputPorts: [], outputPorts: [{ id: 'output', label: 'Input data', dataType: 'object', required: true }], configFields: [], configSchema: z.object({}).passthrough(),
  },
  {
    type: 'agent', category: 'ai', title: 'Agent', description: 'Assigns a bounded piece of work to an active Woody agent.', icon: 'bot', adapter: 'agent', risk: 'unknown', available: true, retryable: true,
    inputPorts: normalInput, outputPorts: normalOutput,
    configFields: [
      { key: 'agentId', label: 'Agent', control: 'resource', resource: 'agent', required: true },
      { key: 'responsibility', label: 'Responsibility', control: 'textarea' },
      { key: 'expectedOutput', label: 'Expected output', control: 'textarea' },
    ],
    configSchema: z.object({ agentId: z.string().uuid(), title: z.string().max(200).optional(), responsibility: z.string().max(5_000).optional(), expectedOutput: z.string().max(5_000).optional(), retry: retrySchema.optional() }).passthrough(),
  },
  {
    type: 'action', category: 'integration', title: 'Legacy tool action', description: 'Calls an existing encrypted API tool. Kept for saved workflow compatibility.', icon: 'wrench', adapter: 'legacy_tool', risk: 'unknown', available: true, retryable: true,
    inputPorts: normalInput, outputPorts: normalOutput,
    configFields: [
      { key: 'toolId', label: 'Tool', control: 'resource', resource: 'api_tool', required: true },
      { key: 'input', label: 'Input mapping', control: 'json' },
    ],
    configSchema: z.object({ toolId: z.string().uuid(), input: recordSchema.optional(), retry: retrySchema.optional() }).passthrough(),
  },
  {
    type: 'condition', category: 'logic', title: 'Condition', description: 'Chooses a true or false path using a safe state reference.', icon: 'split', adapter: 'logic', risk: 'read', available: true, retryable: false,
    inputPorts: normalInput,
    outputPorts: [{ id: 'true', label: 'True', dataType: 'boolean', required: true }, { id: 'false', label: 'False', dataType: 'boolean', required: true }],
    configFields: [
      { key: 'path', label: 'State path', control: 'text', required: true, help: 'Example: input.approved' },
      { key: 'operator', label: 'Operator', control: 'select', required: true, options: ['equals', 'not_equals', 'greater_than', 'greater_or_equal', 'less_than', 'less_or_equal', 'contains', 'exists', 'not_exists'].map((value) => ({ value, label: value.replaceAll('_', ' ') })) },
      { key: 'value', label: 'Comparison value', control: 'json' },
    ],
    configSchema: recordSchema,
  },
  {
    type: 'approval', category: 'human', title: 'Human approval', description: 'Pauses the workflow for a business decision. External writes still require action-bound confirmation.', icon: 'shield-check', adapter: 'logic', risk: 'read', available: true, retryable: false,
    inputPorts: normalInput, outputPorts: normalOutput,
    configFields: [{ key: 'prompt', label: 'Approval prompt', control: 'textarea' }],
    configSchema: z.object({ prompt: z.string().max(2_000).optional() }).passthrough(),
  },
  {
    type: 'loop', category: 'logic', title: 'Controlled loop', description: 'Repeats a path with an enforced maximum iteration count.', icon: 'repeat-2', adapter: 'logic', risk: 'read', available: true, retryable: false,
    inputPorts: normalInput,
    outputPorts: [{ id: 'body', label: 'Loop body', dataType: 'any', required: true }, { id: 'done', label: 'Done', dataType: 'any', required: true }],
    configFields: [
      { key: 'mode', label: 'Loop mode', control: 'select', required: true, options: [{ value: 'forEach', label: 'For each item' }, { value: 'while', label: 'While condition' }] },
      { key: 'collectionPath', label: 'Collection path', control: 'text', help: 'Example: input.items' },
      { key: 'itemVariable', label: 'Item variable', control: 'text' },
      { key: 'indexVariable', label: 'Index variable', control: 'text' },
      { key: 'condition', label: 'While condition', control: 'json' },
      { key: 'maxIterations', label: 'Maximum iterations', control: 'number', required: true },
      { key: 'onLimit', label: 'When the limit is reached', control: 'select', options: [{ value: 'fail', label: 'Fail safely' }, { value: 'exit', label: 'Exit loop' }] },
    ],
    configSchema: recordSchema,
  },
  {
    type: 'output', category: 'output', title: 'Return output', description: 'Completes the workflow and optionally generates downloadable files.', icon: 'file-output', adapter: 'file', risk: 'read', available: true, retryable: false,
    inputPorts: normalInput, outputPorts: [],
    configFields: [
      { key: 'fromNodeId', label: 'Result source', control: 'resource', resource: 'node' },
      { key: 'artifactFormats', label: 'Generate files', control: 'multiselect', options: ['pdf', 'docx', 'pptx', 'xlsx'].map((value) => ({ value, label: value.toUpperCase() })) },
    ],
    configSchema: z.object({ fromNodeId: z.string().max(100).optional(), artifactFormats: z.array(z.enum(['pdf', 'docx', 'pptx', 'xlsx'])).max(4).optional(), output: recordSchema.optional() }).passthrough(),
  },
  {
    type: 'api_action', category: 'integration', title: 'API action', description: 'Calls an enabled custom API through the workflow action policy gateway.', icon: 'plug-zap', adapter: 'api', risk: 'unknown', available: true, retryable: false,
    inputPorts: normalInput, outputPorts: normalOutput,
    configFields: [{ key: 'toolId', label: 'API action', control: 'resource', resource: 'api_tool', required: true }, { key: 'input', label: 'Input mapping', control: 'json' }],
    configSchema: z.object({ toolId: z.string().uuid(), input: recordSchema.optional() }).passthrough(),
  },
  {
    type: 'mcp_action', category: 'integration', title: 'App action', description: 'Calls an exact discovered MCP tool using a selected agent’s allowlist.', icon: 'blocks', adapter: 'mcp', risk: 'unknown', available: true, retryable: false,
    inputPorts: normalInput, outputPorts: normalOutput,
    configFields: [
      { key: 'agentId', label: 'Permission agent', control: 'resource', resource: 'agent', required: true },
      { key: 'mcpToolId', label: 'App action', control: 'resource', resource: 'mcp_tool', required: true },
      { key: 'input', label: 'Input mapping', control: 'json' },
    ],
    configSchema: z.object({ agentId: z.string().uuid(), mcpToolId: z.string().uuid(), input: recordSchema.optional() }).passthrough(),
  },
  {
    type: 'knowledge_search', category: 'knowledge', title: 'Search knowledge', description: 'Retrieves relevant workspace Knowledge for later nodes.', icon: 'library', adapter: 'knowledge', risk: 'read', available: true, retryable: false,
    inputPorts: normalInput, outputPorts: [{ id: 'results', label: 'Search results', dataType: 'collection', required: true }],
    configFields: [{ key: 'query', label: 'Query mapping', control: 'text', required: true }, { key: 'limit', label: 'Maximum results', control: 'number' }],
    configSchema: z.object({ query: z.string().min(1).max(5_000), limit: z.number().int().min(1).max(20).optional() }).passthrough(),
  },
  {
    type: 'browser', category: 'integration', title: 'Browser', description: 'Open pages and interact with websites in a controlled browser session.', icon: 'globe-2', adapter: 'browser', risk: 'unknown', available: false,
    availabilityReason: 'Browser automation needs an isolated, policy-enforced runtime before it can be enabled safely.',
    retryable: false, inputPorts: normalInput, outputPorts: normalOutput, configFields: [], configSchema: z.object({}).passthrough(),
  },
] satisfies RegistryEntry[];

const registry = new Map<WorkflowNodeType, RegistryEntry>(entries.map((entry) => [entry.type, entry]));

export type PublicWorkflowNodeDefinition = Omit<RegistryEntry, 'configSchema'>;

export function workflowNodeDefinition(type: WorkflowNodeType) {
  return registry.get(type);
}

export function publicWorkflowNodeCatalog(): PublicWorkflowNodeDefinition[] {
  return entries.map(({ configSchema: _configSchema, ...entry }) => ({
    ...entry,
    inputPorts: entry.inputPorts.map((port) => ({ ...port })),
    outputPorts: entry.outputPorts.map((port) => ({ ...port })),
    configFields: entry.configFields.map((field: WorkflowConfigField) => ({ ...field, options: field.options?.map((option) => ({ ...option })) })),
  }));
}

export function workflowNodeConfigErrors(node: { id: string; type: WorkflowNodeType; config: Record<string, unknown> }) {
  const definition = workflowNodeDefinition(node.type);
  if (!definition) return [`Node ${node.id} uses an unknown node type`];
  if (!definition.available) return [`${definition.title} node ${node.id} is unavailable: ${definition.availabilityReason ?? 'runtime adapter unavailable'}`];
  const parsed = definition.configSchema.safeParse(node.config);
  const errors = parsed.success ? [] : parsed.error.issues.map((issue) => `Node ${node.id} config ${issue.path.join('.') || 'value'}: ${issue.message}`);
  if (!definition.retryable && 'retry' in node.config) errors.push(`Node ${node.id} does not support automatic retries`);
  return errors;
}
