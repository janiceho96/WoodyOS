import type { WorkflowDefinition, WorkflowNode } from '../definition.js';
import type { ExecutionManifest } from '../../runtime/manifest.js';

export type LoopCursor = { iteration: number };
export type WorkflowCursor = { nodeId: string; loops: Record<string, LoopCursor>; attempt: number; previousNodeId?: string };
export type WorkflowRunRecord = {
  id: string;
  workspace_id: string;
  workflow_id: string;
  input: Record<string, unknown>;
  definition_snapshot: WorkflowDefinition;
  state: Record<string, unknown>;
  cursor: WorkflowCursor | null;
  step_count: number;
  run_mode?: 'test' | 'production';
  execution_manifest?: ExecutionManifest | null;
  test_target_node_id?: string | null;
  name: string;
  created_by: string;
};

export type AgentTaskResult = null | Record<string, unknown>;
export type AgentTaskExecutor = (taskId: string) => Promise<AgentTaskResult>;

export type WorkflowAdapterExecution = {
  output: unknown;
  result?: unknown;
  waiting?: boolean;
  waitingMessage?: string;
  finished?: boolean;
};

export type WorkflowAdapterContext = {
  run: WorkflowRunRecord;
  node: WorkflowNode;
  cursor: WorkflowCursor;
  iterationKey: string;
  executeAgentTask: AgentTaskExecutor;
  emitEvent: (type: string, message: string, payload?: Record<string, unknown>) => Promise<void>;
  resolve: (value: unknown) => unknown;
  setNodeOutput: (value: unknown) => void;
};

export type WorkflowNodeExecutor = (context: WorkflowAdapterContext) => Promise<WorkflowAdapterExecution>;
