import type { WorkflowDefinition, WorkflowNode } from '../definition.js';
import type { ExecutionManifest } from '../../runtime/manifest.js';
import type { TraceContext } from '../../runtime/trace.js';

type BaseExecutionContext = {
  trace: TraceContext;
  signal: AbortSignal;
  leaseOwnerId?: string;
};

export type ExecutionContext = BaseExecutionContext & (
  | { mode: 'production'; manifest: ExecutionManifest }
  | { mode: 'test'; manifest: null }
);

export type LoopCursor = { iteration: number };
export type WorkflowCursor = { nodeId: string; loops: Record<string, LoopCursor>; attempt: number; previousNodeId?: string };
export type WorkflowRunRecord = {
  id: string;
  workspace_id: string;
  workflow_id: string;
  workflow_version_id?: string | null;
  input: Record<string, unknown>;
  definition_snapshot: WorkflowDefinition;
  state: Record<string, unknown>;
  cursor: WorkflowCursor | null;
  step_count: number;
  run_mode?: 'test' | 'production';
  execution_manifest?: ExecutionManifest | null;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  test_target_node_id?: string | null;
  name: string;
  created_by: string;
};

export type AgentTaskResult = null | Record<string, unknown>;
export type AgentTaskExecutor = (
  taskId: string,
  traceId?: string,
  signal?: AbortSignal,
) => Promise<AgentTaskResult>;

export type AgentNodeExecutionIdentity = {
  taskId: string;
  agentVersionId: string;
  outputDocumentVersionId: string;
  modelIdentity: string;
  output: unknown;
};

export type WorkflowAdapterExecution = {
  output: unknown;
  result?: unknown;
  agentExecutionIdentity?: AgentNodeExecutionIdentity;
  waiting?: boolean;
  waitingMessage?: string;
  finished?: boolean;
};

export type WorkflowAdapterContext = {
  execution: ExecutionContext;
  run: WorkflowRunRecord;
  node: WorkflowNode;
  cursor: WorkflowCursor;
  iterationKey: string;
  executeAgentTask: AgentTaskExecutor;
  emitEvent: (type: string, message: string, payload?: Record<string, unknown>, trace?: TraceContext) => Promise<void>;
  resolve: (value: unknown) => unknown;
  setNodeOutput: (value: unknown) => void;
};

export type WorkflowNodeExecutor = (context: WorkflowAdapterContext) => Promise<WorkflowAdapterExecution>;
