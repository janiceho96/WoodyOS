import type { BrandIconKey } from './components/BrandIcon';

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
  workspace: { id: string; name: string; role?: 'owner' | 'admin' | 'member' | 'viewer' };
};

export type DepartmentMembershipType = 'primary' | 'shared';
export type DepartmentStatus = 'active' | 'archived';
export type DepartmentErrorCode =
  | 'DEPARTMENT_NOT_FOUND'
  | 'DEPARTMENT_ARCHIVED'
  | 'DEPARTMENT_NAME_CONFLICT'
  | 'DEPARTMENT_REVISION_CONFLICT'
  | 'DEPARTMENT_AGENT_NOT_FOUND'
  | 'DEPARTMENT_MANAGER_INACTIVE'
  | 'DEPARTMENT_EXECUTIVE_INVALID'
  | 'DEPARTMENT_MEMBERSHIP_NOT_FOUND'
  | 'DEPARTMENT_PRIMARY_MOVE_CONFIRMATION_REQUIRED'
  | 'DEPARTMENT_ACTOR_INVALID';
export type Department = {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  status: DepartmentStatus;
  displayOrder: number;
  managerAgentId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type DepartmentMembership = {
  departmentId: string;
  workspaceId: string;
  agentId: string;
  membershipType: DepartmentMembershipType;
  createdAt: string;
  updatedAt: string;
};
export type OrganizationAgentSummary = {
  id: string;
  name: string;
  role: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  avatar: Record<string, unknown>;
  activeWorkCount: number;
  apiToolCount: number;
  mcpConnectionCount: number;
};
export type OrganizationSnapshot = {
  revision: number;
  executiveAgentId: string | null;
  departments: Department[];
  memberships: DepartmentMembership[];
  agents: OrganizationAgentSummary[];
};
export type DepartmentMutationResult = { revision: number };
export type CreateDepartmentInput = {
  name: string;
  description?: string;
  displayOrder?: number;
  managerAgentId?: string | null;
  confirmPrimaryMove?: boolean;
  expectedRevision: number;
};
export type UpdateDepartmentInput = Partial<Omit<CreateDepartmentInput, 'expectedRevision'>> & {
  expectedRevision: number;
};

export class DepartmentApiError extends Error {
  readonly code: DepartmentErrorCode;
  readonly statusCode: number;
  readonly currentRevision?: number;

  constructor(
    code: DepartmentErrorCode,
    statusCode: number,
    currentRevision?: number,
  ) {
    super(code);
    this.name = 'DepartmentApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.currentRevision = currentRevision;
  }
}

function withTokenStorage(action: (storage: Storage) => void) {
  try {
    if (typeof window !== 'undefined') action(window.localStorage);
  } catch {
    // Browser privacy settings can deny storage while requests still work in-memory.
  }
}

let token = '';
withTokenStorage((storage) => { token = storage.getItem('nexus_token') ?? ''; });

const errorMessages: Record<string, string> = {
  AI_NOT_CONFIGURED: 'AI provider is not configured. Add a provider, API key, and model in the server environment, then restart Woody.',
  AI_PROVIDER_AUTH_FAILED: 'The AI provider rejected the API key. Check the key and restart Woody.',
  AI_PROVIDER_MODEL_NOT_FOUND: 'The configured AI model was not found. Choose a model supported by your provider, then restart Woody.',
  AI_PROVIDER_MODEL_OR_REQUEST_REJECTED: 'The AI provider rejected this request or model. Check the configured model name and provider compatibility.',
  AI_PROVIDER_RATE_LIMITED: 'The AI provider rate limit has been reached. Wait briefly or use a provider/model with available capacity.',
  AI_PROVIDER_REQUEST_FAILED: 'Woody could not reach the AI provider. Check the base URL, network connection, and provider status.',
  AI_PROVIDER_API_KEY_REQUIRED: 'Enter a new API key when switching AI providers.',
  AI_PROVIDER_ENDPOINT_INVALID: 'Enter a valid AI provider base URL.',
  AI_PROVIDER_ENDPOINT_HTTPS_REQUIRED: 'AI provider endpoints must use HTTPS.',
  AI_PROVIDER_ENDPOINT_CREDENTIALS_FORBIDDEN: 'Do not place credentials inside the provider URL.',
  AI_PROVIDER_ENDPOINT_BLOCKED: 'Private, local, and reserved provider endpoints are not allowed.',
  AI_PROVIDER_REDIRECT_BLOCKED: 'The provider redirected outside its configured origin, so Woody blocked the request.',
  AI_PROVIDER_CHANGED_DURING_RUN: 'The AI provider changed while this run was paused. Start a new run with the current provider.',
  PROMPT_COMPILER_INVALID_RESPONSE: 'The AI provider returned a response Woody could not safely turn into an agent proposal. Try again or use a stronger JSON-capable model.',
  AGENT_PROMPT_INVALID_RESPONSE: 'The AI provider returned an incomplete agent prompt. Try again or choose a stronger JSON-capable model.',
  AGENT_PROMPT_RETURNED_SECRET: 'Woody blocked the generated prompt because it may contain a secret.',
  OUTPUT_TASK_NOT_FOUND: 'This task output could not be found.',
  OUTPUT_TASK_NOT_COMPLETED: 'Only completed task outputs can be edited.',
  OUTPUT_SOURCE_EMPTY: 'This task does not contain editable output text.',
  OUTPUT_DOCUMENT_NOT_FOUND: 'This editable output could not be found.',
  OUTPUT_VERSION_NOT_FOUND: 'This output version could not be found.',
  OUTPUT_VERSION_CONFLICT: 'Another editor saved a newer version. Your draft is still safe.',
  OUTPUT_CONTENT_INVALID: 'Output must contain between 1 and 100,000 characters.',
  OUTPUT_ARTIFACT_QUEUE_UNAVAILABLE: 'The revision was saved, but Woody could not start file generation.',
  WORKFLOW_QUEUE_UNAVAILABLE: 'The workflow queue is unavailable. Ensure the Woody worker and Redis are running, then try the test again.',
  WORKFLOW_PUBLISH_REQUIRED: 'Save this workflow as a draft, test it successfully, then publish it.',
  WORKFLOW_SUCCESSFUL_TEST_REQUIRED: 'The current draft must complete a successful test before it can be published.',
  WORKFLOW_NOT_PUBLISHED: 'This workflow is not published yet. Test and publish it before running it.',
  AGENT_AVATAR_UPLOAD_REQUIRED: 'Save the agent first, then upload its picture.',
  AGENT_AVATAR_FILE_REQUIRED: 'Choose a PNG, JPEG, or WebP image.',
  AGENT_AVATAR_TYPE_UNSUPPORTED: 'Use a PNG, JPEG, or WebP image for the agent picture.',
  AGENT_AVATAR_TOO_LARGE: 'Agent pictures must be no larger than 2 MB.',
  AGENT_AVATAR_PROCESSING_FAILED: 'Woody could not safely process this picture. Try another PNG, JPEG, or WebP image.',
  FILE_REQUIRED: 'Choose a supported file to upload.',
  FILE_EMPTY: 'This file is empty.',
  FILE_TOO_LARGE: 'Files must be 25 MB or smaller.',
  FILE_TYPE_UNSUPPORTED: 'Use PDF, DOCX, PPTX, Excel, CSV, Markdown, TXT, HTML, PNG, JPEG, or WebP.',
  FILE_SIGNATURE_MISMATCH: 'The file contents do not match its filename. Export it again and retry.',
  FILE_MIME_MISMATCH: 'The browser reported a different file type than the selected filename.',
  FILE_QUEUE_UNAVAILABLE: 'Woody saved the file but could not start extraction. Check the worker and Redis.',
  FILE_NOT_READY: 'Wait for Woody to finish extracting this file.',
  FILE_ATTACHMENTS_NOT_READY_OR_MISSING: 'One or more attachments are still processing or unavailable.',
  CHAT_ATTACHMENTS_NOT_READY_OR_SCOPED: 'One or more chat attachments are still processing or unavailable.',
  FILE_MALWARE_DETECTED: 'The malware scanner rejected this file.',
  FILE_IS_KNOWLEDGE_SOURCE: 'Remove this document from Knowledge before deleting its source file.',
};
export const auth = {
  get: () => token,
  set: (value: string) => {
    token = value;
    withTokenStorage((storage) => storage.setItem('nexus_token', value));
  },
  clear: () => {
    token = '';
    withTokenStorage((storage) => storage.removeItem('nexus_token'));
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
    if (error.startsWith('DEPARTMENT_')) {
      throw new DepartmentApiError(
        error as DepartmentErrorCode,
        response.status,
        typeof body.currentRevision === 'number' ? body.currentRevision : undefined,
      );
    }
    throw new Error(`${errorMessages[error] ?? error}${explanation}${detail}`);
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

async function requestBlob(path: string): Promise<Blob> {
  const response = await fetch(`${API_URL}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = typeof body.error === 'string' ? body.error : `Request failed (${response.status})`;
    throw new Error(errorMessages[error] ?? error);
  }
  return response.blob();
}

export type AgentModelConfig = { temperature: number; maxTokens: number; topP: number };
export type AgentCapabilities = { webBrowser: boolean; codeInterpreter: boolean; knowledgeBase: boolean };
export type AgentPromptTone = 'professional' | 'friendly' | 'analytical' | 'creative' | 'concise';
export type GeneratedAgentPrompt = {
  goal: string;
  personality: string;
  instructions: string;
  tone: AgentPromptTone;
  provider: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
};
export type AgentAvatarIcon = 'agent' | 'network' | 'search' | 'route' | 'code' | 'pen' | 'megaphone' | 'chart' | 'check' | 'brain' | 'zap' | 'users' | 'coins' | 'palette' | 'shield' | 'sparkles';
export type AgentAvatarConfig =
  | { type: 'icon'; value: AgentAvatarIcon; backgroundColor?: string; accentColor?: string; alt?: string }
  | { type: 'brand'; value: BrandIconKey; backgroundColor?: string; accentColor?: string; alt?: string }
  | { type: 'initials'; value: string; backgroundColor?: string; accentColor?: string; alt?: string }
  | { type: 'image'; value: 'uploaded'; alt?: string };
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
  avatar_config?: AgentAvatarConfig | Record<string, never>;
  created_at: string;
  updated_at: string;
};
export type AgentMcpAccess = {
  agentId: string;
  agentStatus: Agent['status'];
  connections: Array<{
    id: string;
    name: string;
    permissionLevel: 'read' | 'read_write';
    assignmentEnabled: boolean;
    availability: {
      available: boolean;
      status: 'available' | 'agent_inactive' | 'assignment_disabled' | 'connection_disabled' | 'connection_unhealthy';
      connectionEnabled: boolean;
      healthStatus: string;
    };
    tools: Array<{
      id: string;
      remoteName: string;
      title: string | null;
      riskLevel: 'read' | 'write' | 'destructive' | 'external_write' | 'unknown';
      permissionLevel: 'read' | 'read_write';
      assignmentEnabled: boolean;
      availability: {
        available: boolean;
        status: 'available' | 'agent_inactive' | 'assignment_disabled' | 'connection_disabled' | 'connection_unhealthy' | 'tool_disabled';
        toolEnabled: boolean;
      };
    }>;
  }>;
};
export type Task = {
  id: string;
  agent_id: string;
  workflow_run_id?: string | null;
  title: string;
  status: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
  agent_name?: string;
  agent_role?: string;
  agent_avatar?: AgentAvatarConfig | Record<string, never>;
  workflow_name?: string | null;
  artifact_summary?: Array<Pick<Artifact, 'format' | 'status'>>;
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
export type ActionAuthorization = {
  id: string;
  adapter: 'api' | 'mcp' | 'browser';
  resource_id: string;
  operation: string;
  target_summary?: string | null;
  risk_level: 'read' | 'write' | 'external_write' | 'destructive' | 'unknown';
  arguments_summary: Record<string, unknown>;
  arguments_hash: string;
  status: 'awaiting_confirmation' | 'approved' | 'executing' | 'rejected' | 'expired' | 'consumed' | 'failed';
  requested_at: string;
  expires_at: string;
  resolved_at?: string | null;
  consumed_at?: string | null;
  error_message?: string | null;
};
export const artifactFormats = ['pdf', 'docx', 'pptx', 'xlsx', 'html', 'md', 'txt', 'csv', 'json'] as const;
export type ArtifactFormat = typeof artifactFormats[number];
export type PresentationTheme = {
  id: string;
  name: string;
  theme: { style: 'premium-dark' | 'minimal-light' | 'strategy-dashboard' | 'investor-pitch' | 'research-report'; background: string; surface: string; primary: string; accent: string; success: string; text: string; muted: string; headingFont: string; bodyFont: string; visualDirection: string; maxWordsPerSlide: number };
  is_default: boolean;
  created_at: string;
  updated_at: string;
};
export type HtmlArtifactTemplate = {
  id: string;
  name: string;
  format: 'html';
  theme: {
    background: string;
    surface: string;
    text: string;
    muted: string;
    accent: string;
    border: string;
    headingFont: 'system' | 'serif' | 'mono';
    bodyFont: 'system' | 'serif' | 'mono';
    density: 'comfortable' | 'compact';
  };
  is_default: boolean;
  created_at: string;
  updated_at: string;
};
export type Artifact = {
  id: string;
  task_id?: string | null;
  workflow_run_id?: string | null;
  output_document_version_id?: string | null;
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
export type OutputVersion = {
  id: string;
  workspace_id: string;
  document_id: string;
  version_number: number;
  content: string;
  content_hash: string;
  created_by: string | null;
  created_by_name?: string | null;
  created_at: string;
};
export type OutputDocumentDetail = {
  id: string;
  workspace_id: string;
  task_id: string;
  current_version_number: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  currentVersion: OutputVersion;
  versions: OutputVersion[];
};
export type FileAsset = {
  id: string;
  original_name: string;
  extension: 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'xlsm' | 'csv' | 'md' | 'txt' | 'html' | 'png' | 'jpg' | 'jpeg' | 'webp';
  mime_type: string;
  size_bytes: string | number;
  status: 'scanning' | 'extracting' | 'ready' | 'failed';
  scan_status: 'pending' | 'not_configured' | 'clean' | 'infected' | 'failed';
  scope: 'task' | 'conversation' | 'saved' | 'knowledge';
  retention_policy: 'keep' | '30_days' | 'delete_after_task' | 'delete_after_conversation';
  error_message?: string | null;
  metadata?: Record<string, unknown>;
  version_group_id: string;
  version_number: number;
  replaces_file_id?: string | null;
  created_at: string;
  updated_at?: string;
  completed_at?: string | null;
  deduplicated?: boolean;
  extraction?: {
    status: string;
    summary?: string | null;
    characters?: number;
    structured_content?: Record<string, unknown>;
    error_message?: string | null;
  } | null;
};
export type FilePreview = {
  file: FileAsset;
  extraction: {
    content: string;
    summary: string;
    characters: number;
    structured_content: Record<string, unknown>;
    truncated: boolean;
  } | null;
  chunks: Array<{ ordinal: number; locator: string; content: string; metadata: Record<string, unknown> }>;
};
export type SpreadsheetPreview = {
  file: { id: string; original_name: string; extension: string };
  sheets: Array<{ name?: string; range?: string; rowCount?: number; columnCount?: number; truncated?: boolean }>;
  sheet?: string;
  startRow: number;
  rows: unknown[][];
  rowCount: number;
  columnCount: number;
  truncated: boolean;
  hasMore: boolean;
};
export type FileComparison = {
  files: Array<{ id: string; original_name: string; status: string }>;
  similarityPercent: number;
  sharedTerms: string[];
  distinctiveTerms: Record<string, string[]>;
  sharedPassages: Array<{ fileId: string; locator: string; excerpt: string }>;
  samples: Record<string, Array<{ locator: string; excerpt: string }>>;
  method: string;
};
export type ChatThread = {
  id: string;
  title: string;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
  last_message?: string | null;
  message_count?: number;
  messages?: ChatThreadMessage[];
};
export type ChatThreadMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: FileAsset[];
  metadata?: {
    citations?: Array<{ fileId: string; filename: string; locator: string; score: number }>;
  };
  created_at: string;
};
export type TaskDetail = Task & { input?: Record<string, unknown>; events: TaskEvent[]; artifacts: Artifact[]; attachments: FileAsset[]; actionAuthorizations?: ActionAuthorization[] };
export type WorkflowNode = {
  id: string;
  type: 'trigger' | 'agent' | 'action' | 'condition' | 'approval' | 'loop' | 'output' | 'api_action' | 'mcp_action' | 'knowledge_search' | 'browser';
  config: Record<string, unknown>;
};
export type WorkflowDefinition = {
  nodes: WorkflowNode[];
  edges: Array<{ source: string; target: string; condition?: string; sourcePort?: string; targetPort?: string; sourceSchema?: Record<string, unknown>; targetSchema?: Record<string, unknown>; required?: boolean; nullable?: boolean; transformId?: 'json_parse' | 'stringify' }>;
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
  definition_snapshot?: WorkflowDefinition;
  output?: unknown;
  created_at: string;
  completed_at?: string | null;
  events?: Array<{ id: string; node_id: string | null; event_type: string; message: string; payload?: Record<string, unknown>; created_at: string }>;
  approvals?: Array<{ id: string; node_id: string; status: 'pending' | 'approved' | 'rejected'; comment?: string | null; requested_at: string; resolved_at?: string | null }>;
  actionAuthorizations?: Array<{ id: string; node_id: string; iteration_key: string; attempt: number; adapter: 'api' | 'mcp' | 'browser'; resource_id: string; operation: string; target_summary?: string | null; risk_level: string; arguments_summary: Record<string, unknown>; arguments_hash: string; status: 'awaiting_confirmation' | 'approved' | 'executing' | 'rejected' | 'expired' | 'consumed' | 'failed'; requested_at: string; expires_at: string; resolved_at?: string | null; consumed_at?: string | null; error_message?: string | null }>;
  nodeStates?: Array<{ id: string; node_id: string; iteration_key: string; attempt: number; status: string; input?: unknown; output?: unknown; error?: unknown; started_at: string; completed_at?: string | null }>;
  artifacts?: Artifact[];
  usage?: { agentTasks: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number };
};
export type WorkflowReplayEvent = {
  sequence: number;
  timestamp: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  kind: string;
  title: string;
  durationMs: number | null;
  costUsd: number | null;
  status: string;
  summary: Record<string, unknown>;
};
export type WorkflowReplay = {
  run: {
    id: string;
    traceId: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    modelVersions: Array<{ agentId: string; versionId: string; version: number; provider: string; model: string }>;
  };
  events: WorkflowReplayEvent[];
};
export type WorkflowDryRun = {
  valid: boolean;
  executionPath: string[];
  externalActions: Array<{ nodeId: string; adapter: string; resourceId: string; risk: string; permissions: string[]; requiresConfirmation: boolean }>;
  requiredApprovals: Array<{ nodeId: string; reason: string; prompt?: string }>;
  missingResources: Array<{ nodeId: string; resourceId: string; kind: string }>;
  pinnedAgents: Array<{ nodeId: string; agentId: string; versionId: string; version: number }>;
  estimatedBudgets: { agentCalls: number; maxLoopIterations: number; externalActions: number; maxNodeExecutions: number };
  errors: Array<{ code: string; message: string; nodeId?: string; guidance: string }>;
  warnings: Array<{ code: string; message: string; nodeId?: string; guidance: string }>;
  manifest: { definitionHash: string; inputHash: string; dependenciesHash: string; previewHash: string };
};
export type WorkflowRegressionCase = {
  id: string;
  workspace_id: string;
  workflow_id: string;
  name: string;
  input: Record<string, unknown>;
  fixtures: Record<string, unknown>;
  assertions: Array<Record<string, unknown>>;
  created_at: string;
  updated_at: string;
};
export type WorkflowEvaluationRun = {
  id: string;
  workflow_version_id: string;
  regression_case_id: string;
  trace_id: string;
  status: 'running' | 'passed' | 'failed';
  measurements: { costUsd?: number; durationMs?: number; qualityScore?: number | null };
  assertion_results: Array<{ index?: number; kind?: string; passed: boolean; actual?: unknown; expected?: unknown; code?: string; message?: string }>;
  started_at: string;
  completed_at?: string | null;
  regression_case_name?: string;
  workflow_version?: number;
  output?: unknown;
};
export type WorkflowNodeCatalogEntry = {
  type: WorkflowNode['type'];
  category: 'trigger' | 'ai' | 'integration' | 'knowledge' | 'logic' | 'human' | 'output';
  title: string;
  description: string;
  icon: string;
  adapter: 'logic' | 'agent' | 'legacy_tool' | 'api' | 'mcp' | 'knowledge' | 'file' | 'browser';
  risk: 'read' | 'write' | 'external_write' | 'destructive' | 'unknown';
  available: boolean;
  availabilityReason?: string;
  retryable: boolean;
  inspectorSections: Array<'inputs' | 'configuration' | 'conditions' | 'execution' | 'input_collection' | 'variables'>;
  supportsInputMapping: boolean;
  supportsStructuredOutput: boolean;
  supportsDynamicHandles: boolean;
  inputPorts: Array<{ id: string; label: string; dataType: string; required?: boolean }>;
  outputPorts: Array<{ id: string; label: string; dataType: string; required?: boolean }>;
  configFields: Array<{ key: string; label: string; control: 'text' | 'textarea' | 'number' | 'select' | 'json' | 'resource' | 'multiselect'; required?: boolean; resource?: 'agent' | 'api_tool' | 'mcp_tool' | 'node'; options?: Array<{ value: string; label: string }>; help?: string }>;
};
export type WorkflowResources = {
  version: number;
  agents: Array<Pick<Agent, 'id' | 'name' | 'role' | 'status' | 'avatar_config' | 'updated_at'>>;
  apiTools: Array<Pick<ApiTool, 'id' | 'name' | 'kind' | 'description' | 'permissions'>>;
  mcpTools: Array<{ id: string; connectionId: string; connectionName: string; remoteName: string; title?: string | null; description: string; inputSchema: Record<string, unknown>; riskLevel: 'read' | 'write' | 'external_write' | 'destructive' | 'unknown'; agentId: string; connectionPermission: 'read' | 'read_write'; toolPermission: 'read' | 'read_write'; appId?: string | null; appTitle?: string | null; brandColor?: string | null }>;
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
  toolRequirements?: Array<{
    key: string;
    label: string;
    purpose: string;
    permissions: string[];
    required: boolean;
  }>;
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
  resources: { agentIds?: Record<string, string>; departmentId?: string; teamId?: string; workflowId?: string };
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
export type MemoryType = 'preference' | 'fact' | 'decision' | 'project_context' | 'workflow_result' | 'error_resolution' | 'summary' | 'hypothesis';
export type MemoryScope = 'workspace' | 'agent' | 'user';
export type MemoryVerificationStatus = 'user_confirmed' | 'agent_inferred' | 'system_generated' | 'unverified' | 'disputed' | 'superseded';
export type ManagedMemory = {
  id: string;
  agent_id: string | null;
  user_id: string | null;
  kind: 'conversation' | 'knowledge' | 'user';
  content: string;
  importance: number;
  metadata: Record<string, unknown>;
  memory_type: MemoryType;
  scope: MemoryScope;
  source_type: string;
  source_id: string | null;
  confidence: number;
  verification_status: MemoryVerificationStatus;
  expires_at: string | null;
  superseded_by: string | null;
  last_accessed_at: string | null;
  access_count: number;
  created_at: string;
  updated_at: string;
};
export type MemoryManagementFilters = Partial<{
  agentId: string;
  type: MemoryType;
  scope: MemoryScope;
  verificationStatus: MemoryVerificationStatus;
  expiry: 'active' | 'expired' | 'any';
  limit: number;
  offset: number;
}>;
export type UpdateMemoryInput = Partial<{
  content: string;
  importance: number;
  metadata: Record<string, unknown>;
  scope: MemoryScope;
  agentId: string | null;
  expiresAt: string | null;
}>;
type ToolFields = {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  enabled: boolean;
  created_at: string;
  updated_at?: string;
};
export type ApiTool = ToolFields & {
  kind: 'api' | 'plugin' | 'internal';
};
export type LegacyMcpTool = ToolFields & {
  kind: 'mcp';
};
/** Broad compatibility record for `/v1/tools`, which can still return legacy MCP rows. */
export type Tool = ApiTool | LegacyMcpTool;

export function isApiTool(tool: Tool): tool is ApiTool {
  return tool.kind === 'api' || tool.kind === 'plugin' || tool.kind === 'internal';
}
export type DemoApi = {
  slug: string;
  name: string;
  description: string;
  provider: string;
  documentationUrl: string;
  examplePrompt: string;
  permissions: string[];
  installed: boolean;
};
export type WebResearchCatalogItem = {
  id: 'tavily' | 'brave' | 'firecrawl-search' | 'firecrawl-extract' | 'searxng' | 'page-reader' | 'reddit';
  title: string;
  category: string;
  description: string;
  credential: string | null;
  recommended: boolean;
  installed: boolean;
};
export type JobToolCatalogItem = {
  id: 'adzuna';
  title: string;
  category: string;
  description: string;
  credential: string;
  documentationUrl: string;
  termsUrl: string;
  installed: boolean;
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
  activity: Array<{ created_at: string; event_type: string; message: string; title: string; agent_id: string; agent_name: string; agent_role: string; agent_avatar?: AgentAvatarConfig | Record<string, never> }>;
  range?: { days: number; start: string; end: string; timezone: 'UTC' } | null;
  daily?: Array<{
    day: string;
    task_count: string;
    completed_tasks: string;
    failed_tasks: string;
    token_input: string;
    token_output: string;
    api_cost_usd: string;
  }>;
  agent_effectiveness?: Array<{
    agent_id: string;
    agent_name: string;
    agent_role: string;
    agent_avatar?: AgentAvatarConfig | Record<string, never>;
    agent_status: string;
    total_tasks: string;
    completed_tasks: string;
    failed_tasks: string;
    success_rate: string;
    average_duration_ms: string | null;
    token_input: string;
    token_output: string;
    api_cost_usd: string;
  }>;
};
export type RuntimeConfig = {
  provider: 'anthropic' | 'openai-compatible' | 'unknown';
  defaultModel: string;
  source: 'workspace' | 'environment' | 'unconfigured';
  configured: boolean;
  baseUrl: string | null;
  apiKeyHint: string | null;
  status: 'untested' | 'healthy' | 'error' | 'environment';
  lastTestedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  updatedAt: string | null;
};
export type RuntimeConfigTest = { ok: true; status: 'healthy'; provider: RuntimeConfig['provider']; model: string; checkedAt: string };
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
export type McpAgentAccess = Pick<Agent, 'id' | 'name' | 'role' | 'status' | 'avatar_config' | 'updated_at'> & {
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
  agent_id?: string | null;
  agent_name?: string | null;
  agent_role?: string | null;
  agent_avatar?: AgentAvatarConfig | Record<string, never> | null;
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
    request<{ id: string; email: string; display_name: string; workspace_id: string; workspace_name: string; role: NonNullable<Session['workspace']['role']>; onboarding: Onboarding }>('/v1/auth/me'),
  onboarding: (body: { lastStep: number; action?: 'progress' | 'complete' | 'skip' }) =>
    request<Onboarding>('/v1/auth/onboarding', { method: 'PUT', body: JSON.stringify(body) }),
  restartOnboarding: () => request<Onboarding>('/v1/auth/onboarding/restart', { method: 'POST' }),

  analytics: (days?: 1 | 7 | 30) => request<Analytics>(`/v1/analytics/overview${days ? `?days=${days}` : ''}`),
  runtimeConfig: () => request<RuntimeConfig>('/v1/runtime/config'),
  updateRuntimeConfig: (body: { provider: 'anthropic' | 'openai-compatible'; defaultModel: string; baseUrl?: string | null; apiKey?: string }) =>
    request<RuntimeConfig>('/v1/runtime/config', { method: 'PUT', body: JSON.stringify(body) }),
  testRuntimeConfig: () => request<RuntimeConfigTest>('/v1/runtime/config/test', { method: 'POST' }),
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
  agentMcpAccess: (id: string) => request<AgentMcpAccess>(`/v1/agents/${id}/mcp-access`),
  createAgent: (body: Record<string, unknown>) =>
    request<Agent>('/v1/agents', { method: 'POST', body: JSON.stringify(body) }),
  updateAgent: (id: string, body: Record<string, unknown>) =>
    request<Agent>(`/v1/agents/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  generateAgentPrompt: (body: { name?: string; role?: string; goal?: string; tone: AgentPromptTone }) =>
    request<GeneratedAgentPrompt>('/v1/agents/generate-prompt', { method: 'POST', body: JSON.stringify(body) }),
  uploadAgentAvatar: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<Agent>(`/v1/agents/${id}/avatar/image`, { method: 'POST', body: form });
  },
  agentAvatarImage: (id: string) => requestBlob(`/v1/agents/${id}/avatar/image`),
  resetAgentAvatar: (id: string) => request<void>(`/v1/agents/${id}/avatar`, { method: 'DELETE' }),

  departments: () => request<OrganizationSnapshot>('/v1/departments'),
  createDepartment: (body: CreateDepartmentInput) =>
    request<DepartmentMutationResult & { department: Department }>('/v1/departments', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateDepartment: (id: string, body: UpdateDepartmentInput) =>
    request<DepartmentMutationResult>(`/v1/departments/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  archiveDepartment: (id: string, expectedRevision: number) =>
    request<DepartmentMutationResult>(`/v1/departments/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedRevision }),
    }),
  setDepartmentMembership: (
    departmentId: string,
    agentId: string,
    body: { membershipType: DepartmentMembershipType; expectedRevision: number },
  ) => request<DepartmentMutationResult>(`/v1/departments/${departmentId}/members/${agentId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),
  removeDepartmentMembership: (
    departmentId: string,
    agentId: string,
    expectedRevision: number,
  ) => request<DepartmentMutationResult>(`/v1/departments/${departmentId}/members/${agentId}`, {
    method: 'DELETE',
    body: JSON.stringify({ expectedRevision }),
  }),
  setExecutiveAgent: (agentId: string | null, expectedRevision: number) =>
    request<DepartmentMutationResult>('/v1/departments/settings/executive', {
      method: 'PUT',
      body: JSON.stringify({ agentId, expectedRevision }),
    }),

  tasks: () => request<{ data: Task[] }>('/v1/tasks'),
  task: (id: string) => request<TaskDetail>(`/v1/tasks/${id}`),
  createTask: (body: { agentId: string; title: string; input: Record<string, unknown>; artifactFormats?: ArtifactFormat[]; attachmentIds?: string[] }) =>
    request<Task>('/v1/tasks', { method: 'POST', body: JSON.stringify(body) }),
  cancelTask: (id: string) => request<Task>(`/v1/tasks/${id}/cancel`, { method: 'POST' }),
  decideActionAuthorization: (id: string, decision: 'approved' | 'rejected', comment = '') =>
    request<{ id: string; taskId: string; decision: string }>(`/v1/action-authorizations/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision, comment }),
    }),
  taskFeedback: (id: string, body: { rating: number; comment?: string }) =>
    request(`/v1/tasks/${id}/feedback`, { method: 'PUT', body: JSON.stringify(body) }),
  requestArtifacts: (body: { taskId?: string; workflowRunId?: string; formats: ArtifactFormat[] }) =>
    request<{ data: Artifact[] }>('/v1/artifacts', { method: 'POST', body: JSON.stringify(body) }),
  outputDocumentForTask: (taskId: string) =>
    request<{ document: OutputDocumentDetail | null }>(`/v1/output-documents/tasks/${taskId}`),
  initializeOutputDocument: (taskId: string) =>
    request<OutputDocumentDetail>(`/v1/output-documents/tasks/${taskId}`, { method: 'POST' }),
  saveOutputVersion: (documentId: string, body: { content: string; baseVersionNumber: number }) =>
    request<OutputDocumentDetail>(`/v1/output-documents/${documentId}/versions`, { method: 'POST', body: JSON.stringify(body) }),
  revertOutputVersion: (documentId: string, body: { versionId: string; baseVersionNumber: number }) =>
    request<OutputDocumentDetail>(`/v1/output-documents/${documentId}/revert`, { method: 'POST', body: JSON.stringify(body) }),
  requestOutputArtifacts: (documentId: string, body: { versionId: string; formats: ArtifactFormat[] }) =>
    request<{ data: Artifact[] }>(`/v1/output-documents/${documentId}/artifacts`, { method: 'POST', body: JSON.stringify(body) }),
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

  files: () => request<{ data: FileAsset[] }>('/v1/files'),
  file: (id: string) => request<FileAsset>(`/v1/files/${id}`),
  filePreview: (id: string) => request<FilePreview>(`/v1/files/${id}/preview`),
  uploadFile: (file: File, scope: FileAsset['scope']) => {
    const form = new FormData();
    form.append('scope', scope);
    form.append('file', file);
    return request<FileAsset>('/v1/files', { method: 'POST', body: form });
  },
  importFileFromSecureLink: (url: string, scope: FileAsset['scope'], filename?: string) =>
    request<FileAsset>('/v1/files/import', {
      method: 'POST',
      body: JSON.stringify({ provider: 'secure_link', url, scope, ...(filename ? { filename } : {}) }),
    }),
  fileVersions: (id: string) => request<{ data: FileAsset[] }>(`/v1/files/${id}/versions`),
  uploadFileVersion: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<FileAsset>(`/v1/files/${id}/versions`, { method: 'POST', body: form });
  },
  spreadsheetPreview: (id: string, sheet?: string, startRow = 1, limit = 100) =>
    request<SpreadsheetPreview>(`/v1/files/${id}/spreadsheet?${new URLSearchParams({
      ...(sheet ? { sheet } : {}), startRow: String(startRow), limit: String(limit),
    })}`),
  compareFiles: (fileIds: [string, string]) =>
    request<FileComparison>('/v1/files/compare', { method: 'POST', body: JSON.stringify({ fileIds }) }),
  promoteFileToKnowledge: (id: string) =>
    request<Document>(`/v1/files/${id}/add-to-knowledge`, { method: 'POST', body: JSON.stringify({ confirmed: true }) }),
  updateFileRetention: (id: string, retentionPolicy: FileAsset['retention_policy']) =>
    request<FileAsset>(`/v1/files/${id}`, { method: 'PATCH', body: JSON.stringify({ retentionPolicy }) }),
  deleteFile: (id: string) => request<void>(`/v1/files/${id}`, { method: 'DELETE' }),
  chatThreads: () => request<{ data: ChatThread[] }>('/v1/copilot/threads'),
  createChatThread: (title?: string) => request<ChatThread>('/v1/copilot/threads', {
    method: 'POST',
    body: JSON.stringify(title ? { title } : {}),
  }),
  chatThread: (id: string) => request<ChatThread>(`/v1/copilot/threads/${id}`),
  sendChatThreadMessage: (id: string, content: string, attachmentIds: string[] = []) =>
    request<{ user: ChatThreadMessage; assistant: ChatThreadMessage; citations: Array<{ fileId: string; filename: string; locator: string; score: number }> }>(`/v1/copilot/threads/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, attachmentIds }),
    }),
  deleteChatThread: (id: string) => request<void>(`/v1/copilot/threads/${id}`, { method: 'DELETE' }),

  artifactTemplates: () => request<{ data: HtmlArtifactTemplate[] }>('/v1/artifact-templates'),
  createArtifactTemplate: (body: { name: string; format: 'html'; designMarkdown: string; isDefault?: boolean }) =>
    request<HtmlArtifactTemplate>('/v1/artifact-templates', { method: 'POST', body: JSON.stringify(body) }),
  updateArtifactTemplate: (id: string, body: Partial<{ name: string; format: 'html'; designMarkdown: string; isDefault: boolean }>) =>
    request<HtmlArtifactTemplate>(`/v1/artifact-templates/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  workflows: () => request<{ data: Workflow[] }>('/v1/workflows'),
  workflowNodeCatalog: () => request<{ version: number; data: WorkflowNodeCatalogEntry[] }>('/v1/workflow-nodes'),
  workflowQualityLoopTemplate: (body: {
    workerAgentId: string;
    graderAgentId: string;
    revisionStrategy: 'same_worker' | 'dedicated_agent';
    revisionAgentId?: string;
    maximumRevisions: number;
    passingScore: number;
    onLimit: 'return_best' | 'human_review' | 'fail';
  }) => request<WorkflowDefinition>('/v1/workflow-nodes/quality-loop-template', { method: 'POST', body: JSON.stringify(body) }),
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
  dryRunWorkflow: (id: string, input: Record<string, unknown> = {}) =>
    request<WorkflowDryRun>(`/v1/workflows/${id}/dry-run`, { method: 'POST', body: JSON.stringify({ input }) }),
  workflowRegressionCases: (id: string) => request<{ data: WorkflowRegressionCase[] }>(`/v1/workflows/${id}/regression-cases`),
  createWorkflowRegressionCase: (id: string, body: Pick<WorkflowRegressionCase, 'name' | 'input' | 'fixtures' | 'assertions'>) =>
    request<WorkflowRegressionCase>(`/v1/workflows/${id}/regression-cases`, { method: 'POST', body: JSON.stringify(body) }),
  updateWorkflowRegressionCase: (workflowId: string, caseId: string, body: Partial<Pick<WorkflowRegressionCase, 'name' | 'input' | 'fixtures' | 'assertions'>>) =>
    request<WorkflowRegressionCase>(`/v1/workflows/${workflowId}/regression-cases/${caseId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteWorkflowRegressionCase: (workflowId: string, caseId: string) =>
    request<void>(`/v1/workflows/${workflowId}/regression-cases/${caseId}`, { method: 'DELETE' }),
  workflowEvaluationRuns: (id: string) => request<{ data: WorkflowEvaluationRun[] }>(`/v1/workflows/${id}/evaluations`),
  runWorkflowEvaluation: (id: string, body: { caseId: string; workflowVersionId: string }) =>
    request<WorkflowEvaluationRun>(`/v1/workflows/${id}/evaluations`, { method: 'POST', body: JSON.stringify(body) }),
  publishWorkflow: (id: string) =>
    request<Workflow>(`/v1/workflows/${id}/publish`, { method: 'POST' }),
  workflowRun: (id: string) => request<WorkflowRun>(`/v1/workflows/runs/${id}`),
  workflowReplay: (id: string) => request<WorkflowReplay>(`/v1/workflows/runs/${id}/replay`),
  decideWorkflowApproval: (runId: string, approvalId: string, decision: 'approved' | 'rejected', comment = '') =>
    request(`/v1/workflows/runs/${runId}/approvals/${approvalId}`, {
      method: 'POST',
      body: JSON.stringify({ decision, comment }),
    }),
  decideWorkflowAction: (authorizationId: string, decision: 'approved' | 'rejected', comment = '') =>
    request(`/v1/workflow-actions/${authorizationId}/decision`, { method: 'POST', body: JSON.stringify({ decision, comment }) }),

  starterSolutions: () => request<{ data: AgentSolution[] }>('/v1/starter-solutions'),
  starterSolution: (slug: string) => request<AgentSolution>(`/v1/starter-solutions/${slug}`),
  installStarterSolution: (slug: string, allowDuplicate = false, toolIdsByAgentKey: Record<string, string[]> = {}) =>
    request<{ id: string; status: 'draft'; solution: AgentSolution; resources: AgentSolutionInstallation['resources'] }>(`/v1/starter-solutions/${slug}/install`, {
      method: 'POST',
      body: JSON.stringify({ allowDuplicate, toolIdsByAgentKey }),
    }),
  compileAgentSolution: (body: {
    prompt: string;
    mode: 'automatic' | 'single' | 'multi';
    saveDraft?: boolean;
    persistPrompt?: boolean;
    attachmentIds?: string[];
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

  managedMemories: (filters: MemoryManagementFilters = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== undefined) query.set(key, String(value));
    return request<{ data: ManagedMemory[]; pagination: { limit: number; offset: number; nextOffset: number | null } }>(`/v1/memories/manage${query.size ? `?${query}` : ''}`);
  },
  updateMemory: (id: string, body: UpdateMemoryInput) =>
    request<ManagedMemory>(`/v1/memories/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  confirmMemory: (id: string) => request<ManagedMemory>(`/v1/memories/${id}/confirm`, { method: 'POST' }),
  disputeMemory: (id: string) => request<ManagedMemory>(`/v1/memories/${id}/dispute`, { method: 'POST' }),
  expireMemory: (id: string) => request<ManagedMemory>(`/v1/memories/${id}/expire`, { method: 'POST' }),
  supersedeMemory: (id: string, body: { replacementMemoryId?: string; replacement?: Record<string, unknown> }) =>
    request<{ memory: ManagedMemory; replacement: ManagedMemory }>(`/v1/memories/${id}/supersede`, { method: 'POST', body: JSON.stringify(body) }),
  deleteMemory: (id: string) => request<void>(`/v1/memories/${id}`, { method: 'DELETE' }),

  tools: () => request<{ data: Tool[] }>('/v1/tools'),
  demoApis: () => request<{ data: DemoApi[] }>('/v1/tools/demos'),
  installDemoApi: (slug: string) => request<Tool & { alreadyInstalled: boolean }>(`/v1/tools/demos/${encodeURIComponent(slug)}/install`, { method: 'POST' }),
  webResearchCatalog: () => request<{ data: WebResearchCatalogItem[] }>('/v1/tools/web/catalog'),
  installWebResearchTool: (body: Record<string, unknown>) => request<Tool>('/v1/tools/web/install', { method: 'POST', body: JSON.stringify(body) }),
  jobToolCatalog: () => request<{ data: JobToolCatalogItem[] }>('/v1/tools/jobs/catalog'),
  installJobTool: (body: Record<string, unknown>) => request<Tool>('/v1/tools/jobs/install', { method: 'POST', body: JSON.stringify(body) }),
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
