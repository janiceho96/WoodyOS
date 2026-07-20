const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export type Onboarding = {
  version: number;
  completed: boolean;
  lastStep: number;
  completedAt: string | null;
  skippedAt: string | null;
};

export type Session = {
  accessToken: string;
  user: { id: string; email: string; displayName: string; onboarding: Onboarding };
  workspace: { id: string; name: string; role?: string };
};

let token = localStorage.getItem('nexus_token') ?? '';

const errorMessages: Record<string, string> = {
  AI_NOT_CONFIGURED: 'AI provider is not configured. Add a provider, API key, and model in the server environment, then restart Woody.',
  AI_PROVIDER_AUTH_FAILED: 'The AI provider rejected the API key. Check the key and restart Woody.',
  AI_PROVIDER_MODEL_NOT_FOUND: 'The configured AI model was not found. Choose a model supported by your provider, then restart Woody.',
  AI_PROVIDER_MODEL_OR_REQUEST_REJECTED: 'The AI provider rejected this request or model. Check the configured model name and provider compatibility.',
  AI_PROVIDER_RATE_LIMITED: 'The AI provider rate limit has been reached. Wait briefly or use a provider/model with available capacity.',
  AI_PROVIDER_REQUEST_FAILED: 'Woody could not reach the AI provider. Check the base URL, network connection, and provider status.',
  PROMPT_COMPILER_INVALID_RESPONSE: 'The AI provider returned a response Woody could not safely turn into an agent proposal. Try again or use a stronger JSON-capable model.',
  WORKFLOW_QUEUE_UNAVAILABLE: 'The workflow queue is unavailable. Ensure the Woody worker and Redis are running, then try the test again.',
  WORKFLOW_PUBLISH_REQUIRED: 'Save this workflow as a draft, test it successfully, then publish it.',
  WORKFLOW_SUCCESSFUL_TEST_REQUIRED: 'The current draft must complete a successful test before it can be published.',
  WORKFLOW_NOT_PUBLISHED: 'This workflow is not published yet. Test and publish it before running it.',
};
export const auth = {
  get: () => token,
  set: (value: string) => {
    token = value;
    localStorage.setItem('nexus_token', value);
  },
  clear: () => {
    token = '';
    localStorage.removeItem('nexus_token');
  },
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isForm = options.body instanceof FormData;
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body && !isForm ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = Array.isArray(body.details) ? `: ${body.details.join(', ')}` : '';
    const explanation = typeof body.message === 'string' ? `: ${body.message}` : '';
    const error = typeof body.error === 'string' ? body.error : `Request failed (${response.status})`;
    throw new Error(`${errorMessages[error] ?? error}${explanation}${detail}`);
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

export type AgentModelConfig = { temperature: number; maxTokens: number; topP: number };
export type AgentCapabilities = { webBrowser: boolean; codeInterpreter: boolean; knowledgeBase: boolean };
export type Agent = {
  id: string;
  name: string;
  role: string;
  goal: string;
  instructions: string;
  personality: string | null;
  status: 'draft' | 'active' | 'paused' | 'archived';
  model: string;
  model_config: AgentModelConfig;
  capabilities: AgentCapabilities;
  tool_ids: string[];
  memory_config: Record<string, boolean>;
  created_at: string;
  updated_at: string;
};
export type Task = {
  id: string;
  agent_id: string;
  title: string;
  status: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
  agent_name?: string;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  duration_ms?: number | null;
  token_input?: number;
  token_output?: number;
  estimated_cost_usd?: string;
  output?: unknown;
  error?: unknown;
};
export type TaskEvent = {
  id: string;
  event_type: string;
  message: string;
  created_at: string;
  payload?: Record<string, unknown>;
};
export type ArtifactFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx';
export type PresentationTheme = {
  id: string;
  name: string;
  theme: { style: 'premium-dark' | 'minimal-light' | 'strategy-dashboard' | 'investor-pitch' | 'research-report'; background: string; surface: string; primary: string; accent: string; success: string; text: string; muted: string; headingFont: string; bodyFont: string; visualDirection: string; maxWordsPerSlide: number };
  is_default: boolean;
  created_at: string;
  updated_at: string;
};
export type Artifact = {
  id: string;
  task_id?: string | null;
  workflow_run_id?: string | null;
  format: ArtifactFormat;
  status: 'pending' | 'queued' | 'generating' | 'ready' | 'failed' | 'skipped';
  filename: string;
  mime_type: string;
  size_bytes?: string | number | null;
  sha256?: string | null;
  error_message?: string | null;
  created_at: string;
  completed_at?: string | null;
};
export type TaskDetail = Task & { input?: Record<string, unknown>; events: TaskEvent[]; artifacts: Artifact[] };
export type WorkflowNode = {
  id: string;
  type: 'trigger' | 'agent' | 'action' | 'condition' | 'approval' | 'loop' | 'output' | 'api_action' | 'mcp_action' | 'knowledge_search';
  config: Record<string, unknown>;
};
export type WorkflowDefinition = {
  nodes: WorkflowNode[];
  edges: Array<{ source: string; target: string; condition?: string }>;
};
export type Workflow = {
  id: string;
  name: string;
  description: string;
  definition: WorkflowDefinition;
  enabled: boolean;
  status: 'draft' | 'published' | 'paused' | 'archived';
  draft_revision: number;
  published_version_id?: string | null;
  published_version?: number | null;
  latest_test_status?: string | null;
  latest_test_revision?: number | null;
  latest_test_run_id?: string | null;
  created_at: string;
  updated_at: string;
};
export type WorkflowRun = {
  id: string;
  workflow_id: string;
  status: string;
  run_mode?: 'test' | 'production';
  draft_revision?: number | null;
  workflow_version_id?: string | null;
  test_target_node_id?: string | null;
  input: Record<string, unknown>;
  output?: unknown;
  created_at: string;
  completed_at?: string | null;
  events?: Array<{ id: string; node_id: string | null; event_type: string; message: string; payload?: Record<string, unknown>; created_at: string }>;
  approvals?: Array<{ id: string; node_id: string; status: 'pending' | 'approved' | 'rejected'; comment?: string | null; requested_at: string; resolved_at?: string | null }>;
  actionAuthorizations?: Array<{ id: string; node_id: string; iteration_key: string; attempt: number; adapter: 'api' | 'mcp' | 'browser'; resource_id: string; operation: string; target_summary?: string | null; risk_level: string; arguments_summary: Record<string, unknown>; arguments_hash: string; status: 'awaiting_confirmation' | 'approved' | 'executing' | 'rejected' | 'expired' | 'consumed' | 'failed'; requested_at: string; expires_at: string; resolved_at?: string | null; consumed_at?: string | null; error_message?: string | null }>;
  nodeStates?: Array<{ id: string; node_id: string; iteration_key: string; attempt: number; status: string; output?: unknown; error?: unknown; started_at: string; completed_at?: string | null }>;
  artifacts?: Artifact[];
};
export type WorkflowNodeCatalogEntry = {
  type: WorkflowNode['type'];
  category: 'trigger' | 'ai' | 'integration' | 'knowledge' | 'logic' | 'human' | 'output';
  title: string;
  description: string;
  icon: string;
  adapter: 'logic' | 'agent' | 'legacy_tool' | 'api' | 'mcp' | 'knowledge' | 'file';
  risk: 'read' | 'write' | 'external_write' | 'destructive' | 'unknown';
  available: boolean;
  availabilityReason?: string;
  retryable: boolean;
  inputPorts: Array<{ id: string; label: string; dataType: string; required?: boolean }>;
  outputPorts: Array<{ id: string; label: string; dataType: string; required?: boolean }>;
  configFields: Array<{ key: string; label: string; control: 'text' | 'textarea' | 'number' | 'select' | 'json' | 'resource' | 'multiselect'; required?: boolean; resource?: 'agent' | 'api_tool' | 'mcp_tool' | 'node'; options?: Array<{ value: string; label: string }>; help?: string }>;
};
export type WorkflowResources = {
  version: number;
  agents: Array<Pick<Agent, 'id' | 'name' | 'role' | 'status'>>;
  apiTools: Array<Pick<Tool, 'id' | 'name' | 'kind' | 'description' | 'permissions'>>;
  mcpTools: Array<{ id: string; connectionId: string; connectionName: string; remoteName: string; title?: string | null; description: string; inputSchema: Record<string, unknown>; riskLevel: 'read' | 'write' | 'external_write' | 'destructive' | 'unknown'; agentId: string; connectionPermission: 'read' | 'read_write'; toolPermission: 'read' | 'read_write' }>;
  knowledge: { scope: 'workspace'; total: number; ready: number; processing: number; failed: number };
};
export type WorkflowEditorLayout = {
  workflowId?: string;
  schemaVersion: number;
  positions: Array<{ nodeId: string; x: number; y: number }>;
  viewport: { x: number; y: number; zoom: number };
  updatedAt?: string | null;
};
export type AgentSolutionAgent = {
  key: string;
  name: string;
  role: string;
  goal: string;
  instructions: string;
  personality: string | null;
  model?: string;
  modelConfig: AgentModelConfig;
  capabilities: AgentCapabilities;
};
export type AgentSolution = {
  slug: string;
  version: number;
  source: 'starter' | 'generated' | 'imported';
  name: string;
  description: string;
  category: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  estimatedModelCalls: number;
  estimatedTokenRange: { minimum: number; maximum: number };
  requiredInputs: Array<{ key: string; label: string; description: string; required: boolean; example?: string }>;
  agents: AgentSolutionAgent[];
  team: { name: string; description: string; managerAgentKey?: string };
  workflow: {
    name: string;
    description: string;
    nodes: Array<{ id: string; type: 'trigger' | 'agent' | 'approval' | 'output'; agentKey?: string; config: Record<string, unknown> }>;
    edges: Array<{ source: string; target: string }>;
  };
  expectedMarkdownOutput: string;
  recommendedIntegrations: Array<{
    id: string;
    name: string;
    purpose: string;
    required: boolean;
    permission: 'read' | 'read_write';
    toolHints: string[];
  }>;
  requiredPermissions: Array<{
    resource: string;
    level: 'read' | 'read_write' | 'destructive';
    reason: string;
    requiresConfirmation: boolean;
  }>;
  humanApprovalRequirements: string[];
  missingQuestions: string[];
  warnings: string[];
};
export type AgentSolutionInstallation = {
  id: string;
  source_type: AgentSolution['source'];
  solution_slug: string;
  solution_version: number;
  solution_name: string;
  status: 'draft' | 'active' | 'archived';
  solution: AgentSolution;
  resources: { agentIds?: Record<string, string>; teamId?: string; workflowId?: string };
  last_test_run_id?: string | null;
  last_test_status?: string | null;
  last_tested_at?: string | null;
  activated_at?: string | null;
  created_at: string;
  updated_at: string;
};
export type Document = {
  id: string;
  name: string;
  source_type: string;
  source_uri?: string | null;
  status: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
};
export type KnowledgeDocumentDetail = Document & {
  content?: string | null;
  chunks: Array<{ id: string; ordinal: number; content: string; metadata?: Record<string, unknown> }>;
  chunk_count: number;
};
export type KnowledgeResult = {
  id: string;
  document_id: string;
  document_name: string;
  ordinal: number;
  content: string;
  score: number;
};
export type Tool = {
  id: string;
  name: string;
  kind: 'mcp' | 'api' | 'plugin' | 'internal';
  description: string;
  permissions: string[];
  enabled: boolean;
  created_at: string;
  updated_at?: string;
};
export type Analytics = {
  agents: { active_agents: string };
  tasks: {
    running_tasks: string;
    completed_tasks: string;
    failed_tasks: string;
    success_rate: string;
    average_duration_ms: string | null;
  };
  usage: { token_input: string; token_output: string; api_cost_usd: string };
  satisfaction: { average_rating: string; ratings_count: string };
  activity: Array<{ created_at: string; event_type: string; message: string; title: string; agent_name: string }>;
};
export type RuntimeConfig = {
  provider: 'anthropic' | 'openai-compatible' | 'unknown';
  defaultModel: string;
};
export type WoodyChatMessage = { role: 'user' | 'assistant'; content: string };
export type WoodyChatResponse = {
  message: string;
  provider: RuntimeConfig['provider'];
  model: string;
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
};
export type AiQuotaStatus = {
  state: 'unconfigured' | 'healthy' | 'warning' | 'blocked';
  blocked: boolean;
  budget: {
    monthlyRequestLimit: number | null;
    monthlyTokenLimit: number | null;
    monthlyCostLimitUsd: number | null;
    inputCostPerMillionUsd: number | null;
    outputCostPerMillionUsd: number | null;
    warningPercent: number;
    hardLimit: boolean;
  };
  usage: {
    requestsUsed: number;
    inputTokens: number;
    outputTokens: number;
    tokensUsed: number;
    costUsedUsd: number;
  };
  percentages: { requests: number | null; tokens: number | null; cost: number | null };
  maximumPercent: number;
  period: { start: string; end: string; trackedSince: string | null };
  provider: null | {
    name: string;
    model: string;
    requestId: string | null;
    requestLimit: number | null;
    requestsRemaining: number | null;
    requestsResetAt: string | null;
    tokenLimit: number | null;
    tokensRemaining: number | null;
    tokensResetAt: string | null;
    creditRemainingUsd: number | null;
    capturedAt: string;
  };
};
export type McpCatalogEndpoint = {
  id: string;
  transport: string;
  endpoint_url: string;
  header_inputs: Array<{ name: string; description?: string; isRequired?: boolean; isSecret?: boolean }>;
  supported: boolean;
};
export type McpCatalogServer = {
  id: string;
  registry_name: string;
  version: string;
  title: string;
  description: string;
  website_url?: string | null;
  repository_url?: string | null;
  icon_url?: string | null;
  registry_status: string;
  registry_updated_at?: string | null;
  endpoints: McpCatalogEndpoint[];
};
export type CuratedMcpApp = {
  id: string;
  title: string;
  publisher: string;
  category: string;
  description: string;
  endpointUrl: string | null;
  registryName?: string;
  docsUrl: string;
  verifiedDomain: string;
  availability: 'available' | 'preview' | 'limited' | 'desktop_bridge';
  installable: boolean;
  authModes: Array<'none' | 'oauth2' | 'bearer' | 'custom_headers'>;
  defaultAuth: 'none' | 'oauth2' | 'bearer' | 'custom_headers';
  requiresOAuthClient?: boolean;
  setupNote: string;
  capabilities: string[];
  brandColor: string;
  catalogServerId?: string | null;
  catalogEndpointId?: string | null;
};
export type McpConnection = {
  id: string;
  catalog_server_id?: string | null;
  name: string;
  description: string;
  transport: 'streamable-http';
  endpoint_url: string;
  auth_type: 'none' | 'bearer' | 'custom_headers' | 'oauth2';
  authorized?: boolean;
  enabled: boolean;
  health_status: string;
  consecutive_failures?: number;
  last_health_check_at?: string | null;
  last_success_at?: string | null;
  last_error_code?: string | null;
  last_error_message?: string | null;
  server_info?: Record<string, unknown>;
  tool_count?: number;
  agent_count?: number;
  created_at: string;
  updated_at?: string;
};
export type McpTool = {
  id: string;
  remote_name: string;
  title?: string | null;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown> | null;
  annotations: Record<string, unknown>;
  risk_level: 'read' | 'write' | 'destructive' | 'external_write' | 'unknown';
  enabled: boolean;
  discovered_at: string;
};
export type McpAgentAccess = Pick<Agent, 'id' | 'name' | 'role' | 'status'> & {
  permission_level?: 'read' | 'read_write' | null;
  enabled?: boolean | null;
  tools: Array<{ toolId: string; permissionLevel: 'read' | 'read_write'; enabled: boolean }>;
};
export type McpToolCall = {
  id: string;
  status: string;
  risk_level: string;
  arguments_summary: Record<string, unknown>;
  result_summary?: unknown;
  error_code?: string | null;
  error_message?: string | null;
  duration_ms?: number | null;
  requested_at: string;
  completed_at?: string | null;
  remote_name: string;
  tool_title?: string | null;
  connection_name: string;
  agent_name?: string | null;
  task_title?: string | null;
  confirmation_status?: string | null;
  action_summary?: string | null;
  target_summary?: string | null;
  expires_at?: string | null;
};

export const api = {
  register: (body: { email: string; password: string; displayName: string; workspaceName: string }) =>
    request<Session>('/v1/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (body: { email: string; password: string }) =>
    request<Session>('/v1/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  me: () =>
    request<{ id: string; email: string; display_name: string; workspace_id: string; workspace_name: string; onboarding: Onboarding }>('/v1/auth/me'),
  onboarding: (body: { lastStep: number; action?: 'progress' | 'complete' | 'skip' }) =>
    request<Onboarding>('/v1/auth/onboarding', { method: 'PUT', body: JSON.stringify(body) }),
  restartOnboarding: () => request<Onboarding>('/v1/auth/onboarding/restart', { method: 'POST' }),

  analytics: () => request<Analytics>('/v1/analytics/overview'),
  runtimeConfig: () => request<RuntimeConfig>('/v1/runtime/config'),
  woodyChat: (messages: WoodyChatMessage[]) => request<WoodyChatResponse>('/v1/copilot/chat', {
    method: 'POST',
    body: JSON.stringify({ messages }),
  }),
  aiQuota: () => request<AiQuotaStatus>('/v1/usage/quota'),
  updateAiBudget: (body: AiQuotaStatus['budget']) => request<AiQuotaStatus>('/v1/usage/budget', {
    method: 'PUT',
    body: JSON.stringify(body),
  }),
  presentationThemes: () => request<{ data: PresentationTheme[] }>('/v1/presentation-themes'),
  createPresentationTheme: (body: { name: string; designMarkdown: string; isDefault?: boolean }) => request<PresentationTheme>('/v1/presentation-themes', { method: 'POST', body: JSON.stringify(body) }),
  updatePresentationTheme: (id: string, body: Partial<{ name: string; designMarkdown: string; isDefault: boolean }>) => request<PresentationTheme>(`/v1/presentation-themes/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deletePresentationTheme: (id: string) => request<void>(`/v1/presentation-themes/${id}`, { method: 'DELETE' }),

  agents: () => request<{ data: Agent[] }>('/v1/agents'),
  agent: (id: string) => request<Agent>(`/v1/agents/${id}`),
  createAgent: (body: Record<string, unknown>) =>
    request<Agent>('/v1/agents', { method: 'POST', body: JSON.stringify(body) }),
  updateAgent: (id: string, body: Record<string, unknown>) =>
    request<Agent>(`/v1/agents/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  tasks: () => request<{ data: Task[] }>('/v1/tasks'),
  task: (id: string) => request<TaskDetail>(`/v1/tasks/${id}`),
  createTask: (body: { agentId: string; title: string; input: Record<string, unknown>; artifactFormats?: ArtifactFormat[] }) =>
    request<Task>('/v1/tasks', { method: 'POST', body: JSON.stringify(body) }),
  cancelTask: (id: string) => request<Task>(`/v1/tasks/${id}/cancel`, { method: 'POST' }),
  taskFeedback: (id: string, body: { rating: number; comment?: string }) =>
    request(`/v1/tasks/${id}/feedback`, { method: 'PUT', body: JSON.stringify(body) }),
  requestArtifacts: (body: { taskId?: string; workflowRunId?: string; formats: ArtifactFormat[] }) =>
    request<{ data: Artifact[] }>('/v1/artifacts', { method: 'POST', body: JSON.stringify(body) }),
  deleteArtifact: (id: string) => request<void>(`/v1/artifacts/${id}`, { method: 'DELETE' }),
  artifactFile: async (id: string, inline = false) => {
    const response = await fetch(`${API_URL}/v1/artifacts/${id}/download${inline ? '?inline=true' : ''}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Download failed (${response.status})`);
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    return { blob: await response.blob(), filename: encoded ? decodeURIComponent(encoded) : `woody-artifact-${id}` };
  },

  workflows: () => request<{ data: Workflow[] }>('/v1/workflows'),
  workflowNodeCatalog: () => request<{ version: number; data: WorkflowNodeCatalogEntry[] }>('/v1/workflow-nodes'),
  workflowResources: () => request<WorkflowResources>('/v1/workflow-resources'),
  workflowLayout: (id: string) => request<WorkflowEditorLayout>(`/v1/workflows/${id}/layout`),
  saveWorkflowLayout: (id: string, layout: Omit<WorkflowEditorLayout, 'workflowId' | 'updatedAt'>) => request<WorkflowEditorLayout>(`/v1/workflows/${id}/layout`, { method: 'PUT', body: JSON.stringify(layout) }),
  createWorkflow: (body: Record<string, unknown>) =>
    request<Workflow>('/v1/workflows', { method: 'POST', body: JSON.stringify(body) }),
  updateWorkflow: (id: string, body: Record<string, unknown>) =>
    request<Workflow>(`/v1/workflows/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  runWorkflow: (id: string, input: Record<string, unknown> = {}) =>
    request<WorkflowRun>(`/v1/workflows/${id}/runs`, { method: 'POST', body: JSON.stringify({ input }) }),
  testWorkflow: (id: string, input: Record<string, unknown> = {}) =>
    request<WorkflowRun>(`/v1/workflows/${id}/test-runs`, { method: 'POST', body: JSON.stringify({ input }) }),
  testWorkflowNode: (id: string, nodeId: string, input: Record<string, unknown> = {}) =>
    request<WorkflowRun>(`/v1/workflows/${id}/nodes/${encodeURIComponent(nodeId)}/test-runs`, { method: 'POST', body: JSON.stringify({ input }) }),
  publishWorkflow: (id: string) =>
    request<Workflow>(`/v1/workflows/${id}/publish`, { method: 'POST' }),
  workflowRun: (id: string) => request<WorkflowRun>(`/v1/workflows/runs/${id}`),
  decideWorkflowApproval: (runId: string, approvalId: string, decision: 'approved' | 'rejected', comment = '') =>
    request(`/v1/workflows/runs/${runId}/approvals/${approvalId}`, {
      method: 'POST',
      body: JSON.stringify({ decision, comment }),
    }),
  decideWorkflowAction: (authorizationId: string, decision: 'approved' | 'rejected', comment = '') =>
    request(`/v1/workflow-actions/${authorizationId}/decision`, { method: 'POST', body: JSON.stringify({ decision, comment }) }),

  starterSolutions: () => request<{ data: AgentSolution[] }>('/v1/starter-solutions'),
  starterSolution: (slug: string) => request<AgentSolution>(`/v1/starter-solutions/${slug}`),
  installStarterSolution: (slug: string, allowDuplicate = false) =>
    request<{ id: string; status: 'draft'; solution: AgentSolution; resources: AgentSolutionInstallation['resources'] }>(`/v1/starter-solutions/${slug}/install`, {
      method: 'POST',
      body: JSON.stringify({ allowDuplicate }),
    }),
  compileAgentSolution: (body: {
    prompt: string;
    mode: 'automatic' | 'single' | 'multi';
    saveDraft?: boolean;
    persistPrompt?: boolean;
  }) => request<{ solution: AgentSolution; draftId: string | null }>('/v1/agent-solutions/compile', {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  installAgentSolution: (body: {
    solution: AgentSolution;
    allowDuplicate?: boolean;
    sourcePrompt?: string;
    persistPrompt?: boolean;
  }) => request<{ id: string; status: 'draft'; solution: AgentSolution; resources: AgentSolutionInstallation['resources'] }>('/v1/agent-solutions/install', {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  agentSolutionInstallations: () =>
    request<{ data: AgentSolutionInstallation[] }>('/v1/agent-solutions/installations'),
  testAgentSolution: (id: string, input: Record<string, unknown>) =>
    request<WorkflowRun>(`/v1/agent-solutions/installations/${id}/test`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    }),
  activateAgentSolution: (id: string) =>
    request<{ id: string; status: 'active' }>(`/v1/agent-solutions/installations/${id}/activate`, { method: 'POST' }),

  documents: () => request<{ data: Document[] }>('/v1/knowledge/documents'),
  document: (id: string) => request<KnowledgeDocumentDetail>(`/v1/knowledge/documents/${id}`),
  createDocument: (body: Record<string, unknown>) =>
    request<Document>('/v1/knowledge/documents', { method: 'POST', body: JSON.stringify(body) }),
  uploadDocument: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<Document>('/v1/knowledge/documents/upload', { method: 'POST', body: form });
  },
  searchKnowledge: (query: string) =>
    request<{ mode: 'semantic' | 'full_text'; data: KnowledgeResult[] }>('/v1/knowledge/search', {
      method: 'POST',
      body: JSON.stringify({ query }),
    }),
  deleteDocument: (id: string) => request<void>(`/v1/knowledge/documents/${id}`, { method: 'DELETE' }),

  tools: () => request<{ data: Tool[] }>('/v1/tools'),
  createTool: (body: Record<string, unknown>) =>
    request<Tool>('/v1/tools', { method: 'POST', body: JSON.stringify(body) }),
  updateTool: (id: string, body: Record<string, unknown>) =>
    request<Tool>(`/v1/tools/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  testTool: (id: string) => request<{ toolId: string; status: string }>(`/v1/tools/${id}/test`, { method: 'POST' }),

  mcpCatalog: (search = '') =>
    request<{ data: McpCatalogServer[]; total: number }>(`/v1/mcp/catalog?search=${encodeURIComponent(search)}&limit=48&supportedOnly=true`),
  featuredMcpApps: () =>
    request<{ data: CuratedMcpApp[] }>('/v1/mcp/catalog/featured'),
  mcpSyncStatus: () => request<{ data: Record<string, unknown> | null }>('/v1/mcp/catalog/sync/status'),
  syncMcpCatalog: (forceFull = false) =>
    request<{ status: string; serversSeen: number; serversUpdated: number }>('/v1/mcp/catalog/sync', {
      method: 'POST',
      body: JSON.stringify({ forceFull }),
    }),
  mcpConnections: () => request<{ data: McpConnection[] }>('/v1/mcp/connections'),
  createMcpConnection: (body: Record<string, unknown>) =>
    request<McpConnection>('/v1/mcp/connections', { method: 'POST', body: JSON.stringify(body) }),
  updateMcpConnection: (id: string, body: Record<string, unknown>) =>
    request<McpConnection>(`/v1/mcp/connections/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  updateMcpCredentials: (id: string, body: Record<string, unknown>) =>
    request<void>(`/v1/mcp/connections/${id}/credentials`, { method: 'PUT', body: JSON.stringify(body) }),
  startMcpOAuth: (id: string) =>
    request<{ authorizationUrl: string }>(`/v1/mcp/connections/${id}/auth/start`, { method: 'POST' }),
  testMcpConnection: (id: string) =>
    request<{ status: string; durationMs: number; toolsAvailable: number; serverInfo: Record<string, unknown> }>(`/v1/mcp/connections/${id}/test`, { method: 'POST' }),
  discoverMcpTools: (id: string) =>
    request<{ discovered: number }>(`/v1/mcp/connections/${id}/discover-tools`, { method: 'POST' }),
  deleteMcpConnection: (id: string) => request<void>(`/v1/mcp/connections/${id}`, { method: 'DELETE' }),
  mcpTools: (id: string) => request<{ data: McpTool[] }>(`/v1/mcp/connections/${id}/tools`),
  updateMcpTools: (connectionId: string, mode: 'enable_read_only' | 'disable_all') =>
    request<{ mode: string; enabled: number; disabled: number }>(`/v1/mcp/connections/${connectionId}/tools`, {
      method: 'PATCH',
      body: JSON.stringify({ mode }),
    }),
  updateMcpTool: (connectionId: string, toolId: string, body: Record<string, unknown>) =>
    request<McpTool>(`/v1/mcp/connections/${connectionId}/tools/${toolId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  mcpConnectionAgents: (id: string) =>
    request<{ data: McpAgentAccess[] }>(`/v1/mcp/connections/${id}/agents`),
  updateMcpAgentAccess: (connectionId: string, agentId: string, body: {
    permissionLevel: 'read' | 'read_write';
    toolIds: string[];
    enabled: boolean;
  }) => request(`/v1/mcp/connections/${connectionId}/agents/${agentId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),
  mcpToolCalls: () => request<{ data: McpToolCall[] }>('/v1/mcp/tool-calls?limit=100'),
  decideMcpToolCall: (id: string, decision: 'approved' | 'rejected', comment = '') =>
    request<{ id: string; taskId: string; decision: string }>(`/v1/mcp/tool-calls/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision, comment }),
    }),
};
