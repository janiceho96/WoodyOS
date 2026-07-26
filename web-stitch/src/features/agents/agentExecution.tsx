/* oxlint-disable react/only-export-components -- provider and hook intentionally share one context module */
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type Agent, type Task, type TaskDetail, type WorkflowRun } from '../../api';
import { useWorkspace } from '../../app/workspace';

export type AgentSection = 'overview' | 'workspace' | 'configure' | 'workflow' | 'history';
export type ActivityFilter = 'all' | 'agent' | 'tools' | 'approvals' | 'errors' | 'results';
export type ExecutionStepStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export type ExecutionStep = {
  id: string;
  label: string;
  kind: string;
  status: ExecutionStepStatus;
  eventIds: string[];
};

export type UnifiedActivityEvent = {
  id: string;
  stepId?: string;
  category: Exclude<ActivityFilter, 'all'>;
  type: string;
  title: string;
  message: string;
  status: ExecutionStepStatus;
  createdAt: string;
  payload?: Record<string, unknown>;
  source: 'task' | 'workflow';
};

export type AgentExecutionView = {
  agent: Agent;
  tasks: Task[];
  task?: TaskDetail;
  workflowRun?: WorkflowRun;
  steps: ExecutionStep[];
  events: UnifiedActivityEvent[];
  status: Task['status'] | 'ready';
  currentStepId?: string;
  completedSteps: number;
  progressPercent: number | null;
  pendingApprovals: number;
  errorCount: number;
  elapsedMs: number | null;
};

type ExecutionContextValue = AgentExecutionView & {
  section: AgentSection;
  taskLoading: boolean;
  workflowLoading: boolean;
  selectedStepId?: string;
  selectedEventId?: string;
  activityFilter: ActivityFilter;
  setSection: (section: AgentSection) => void;
  selectTask: (taskId?: string, section?: AgentSection) => void;
  selectStep: (stepId?: string) => void;
  selectEvent: (eventId?: string, stepId?: string) => void;
  setActivityFilter: (filter: ActivityFilter) => void;
  refresh: () => Promise<void>;
};

const AgentExecutionContext = createContext<ExecutionContextValue | null>(null);

const sections: AgentSection[] = ['overview', 'workspace', 'configure', 'workflow', 'history'];
const filters: ActivityFilter[] = ['all', 'agent', 'tools', 'approvals', 'errors', 'results'];
const terminal = new Set(['completed', 'failed', 'cancelled']);

function eventCategory(type: string): UnifiedActivityEvent['category'] {
  const value = type.toLowerCase();
  if (value.includes('fail') || value.includes('error')) return 'errors';
  if (value.includes('approval') || value.includes('authorization') || value === 'action.requested') return 'approvals';
  if (value.includes('tool') || value.includes('action') || value.includes('browser') || value.includes('mcp') || value.includes('api')) return 'tools';
  if (value.includes('completed') || value.includes('result') || value.includes('artifact') || value.includes('output')) return 'results';
  return 'agent';
}

function eventStatus(type: string): ExecutionStepStatus {
  const value = type.toLowerCase();
  if (value.includes('fail') || value.includes('error') || value.includes('rejected')) return 'failed';
  if (value.includes('approval') || value.includes('authorization') || value === 'action.requested') return 'waiting_approval';
  if (value.includes('completed') || value.includes('success') || value.includes('consumed')) return 'completed';
  if (value.includes('cancel')) return 'cancelled';
  return 'running';
}

function nodeStatus(status: string | undefined): ExecutionStepStatus {
  if (!status) return 'pending';
  if (status === 'awaiting_approval' || status === 'awaiting_confirmation') return 'waiting_approval';
  if (status === 'queued') return 'pending';
  if (status === 'succeeded') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'skipped') return 'skipped';
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'completed';
  return 'running';
}

function nodeLabel(node: NonNullable<WorkflowRun['definition_snapshot']>['nodes'][number], agents: Agent[]) {
  if (node.type === 'agent' && typeof node.config.agentId === 'string') return agents.find((candidate) => candidate.id === node.config.agentId)?.name ?? 'Agent step';
  const title = node.config.label ?? node.config.name ?? node.config.title ?? node.config.toolName ?? node.config.operation;
  return typeof title === 'string' && title.trim() ? title : node.type.replaceAll('_', ' ');
}

function buildExecution(agent: Agent, agents: Agent[], tasks: Task[], task: TaskDetail | undefined, workflowRun: WorkflowRun | undefined): AgentExecutionView {
  const agentNodeId = workflowRun?.definition_snapshot?.nodes.find((node) => node.type === 'agent' && node.config.agentId === agent.id)?.id;
  const taskEvents: UnifiedActivityEvent[] = (task?.events ?? []).map((event) => ({
    id: `task:${event.id}`,
    stepId: agentNodeId,
    category: eventCategory(event.event_type),
    type: event.event_type,
    title: event.event_type.replaceAll('.', ' '),
    message: event.message,
    status: eventStatus(event.event_type),
    createdAt: event.created_at,
    payload: event.payload,
    source: 'task',
  }));
  const workflowEvents: UnifiedActivityEvent[] = (workflowRun?.events ?? []).map((event) => ({
    id: `workflow:${event.id}`,
    stepId: event.node_id ?? undefined,
    category: eventCategory(event.event_type),
    type: event.event_type,
    title: event.event_type.replaceAll('.', ' '),
    message: event.message,
    status: eventStatus(event.event_type),
    createdAt: event.created_at,
    payload: event.payload,
    source: 'workflow',
  }));
  const events = [...workflowEvents, ...taskEvents].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  let steps: ExecutionStep[];
  if (workflowRun?.definition_snapshot?.nodes.length) {
    steps = workflowRun.definition_snapshot.nodes.map((node) => {
      const states = (workflowRun.nodeStates ?? []).filter((state) => state.node_id === node.id);
      const latest = states.at(-1);
      const waiting = workflowRun.approvals?.some((approval) => approval.node_id === node.id && approval.status === 'pending')
        || workflowRun.actionAuthorizations?.some((authorization) => authorization.node_id === node.id && authorization.status === 'awaiting_confirmation');
      return {
        id: node.id,
        label: nodeLabel(node, agents),
        kind: node.type,
        status: waiting ? 'waiting_approval' : nodeStatus(latest?.status),
        eventIds: workflowEvents.filter((event) => event.stepId === node.id).map((event) => event.id),
      };
    });
  } else if (task) {
    const began = task.status !== 'queued';
    steps = [
      { id: 'queued', label: 'Task accepted', kind: 'task', status: began ? 'completed' : 'running', eventIds: taskEvents.filter((event) => event.type.includes('queued')).map((event) => event.id) },
      { id: 'agent-work', label: 'Agent work', kind: 'agent', status: task.status === 'awaiting_approval' ? 'waiting_approval' : task.status === 'running' ? 'running' : terminal.has(task.status) ? (task.status === 'failed' ? 'failed' : task.status === 'cancelled' ? 'cancelled' : 'completed') : 'pending', eventIds: taskEvents.filter((event) => !event.type.includes('queued') && !event.type.includes('completed') && !event.type.includes('failed')).map((event) => event.id) },
      { id: 'result', label: 'Result', kind: 'output', status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : task.status === 'cancelled' ? 'cancelled' : 'pending', eventIds: taskEvents.filter((event) => event.category === 'results' || event.category === 'errors').map((event) => event.id) },
    ];
  } else {
    steps = [];
  }
  const currentStep = steps.find((step) => ['running', 'waiting_approval', 'failed'].includes(step.status)) ?? steps.find((step) => step.status === 'pending') ?? steps.at(-1);
  const completedSteps = steps.filter((step) => ['completed', 'skipped'].includes(step.status)).length;
  const startedAt = task?.started_at ?? task?.created_at;
  const endedAt = task?.completed_at;
  const elapsedMs = startedAt ? Math.max(0, new Date(endedAt ?? Date.now()).getTime() - new Date(startedAt).getTime()) : null;
  return {
    agent,
    tasks,
    task,
    workflowRun,
    steps,
    events,
    status: task?.status ?? 'ready',
    currentStepId: currentStep?.id,
    completedSteps,
    progressPercent: steps.length ? Math.round((completedSteps / steps.length) * 100) : null,
    pendingApprovals: (task?.actionAuthorizations?.filter((item) => item.status === 'awaiting_confirmation').length ?? 0)
      + (workflowRun?.approvals?.filter((item) => item.status === 'pending').length ?? 0)
      + (workflowRun?.actionAuthorizations?.filter((item) => item.status === 'awaiting_confirmation').length ?? 0),
    errorCount: events.filter((event) => event.category === 'errors').length,
    elapsedMs,
  };
}

export function AgentExecutionProvider({ agent, children }: { agent: Agent; children: ReactNode }) {
  const { data, reportError } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const tasks = useMemo(() => data.tasks.filter((task) => task.agent_id === agent.id), [data.tasks, agent.id]);
  const requestedTaskId = params.get('task');
  const selectedTask = tasks.find((task) => task.id === requestedTaskId)
    ?? tasks.find((task) => ['running', 'queued', 'awaiting_approval'].includes(task.status))
    ?? tasks[0];
  useEffect(() => {
    if (requestedTaskId || !selectedTask) return;
    const next = new URLSearchParams(params);
    next.set('task', selectedTask.id);
    setParams(next, { replace: true });
  }, [params, requestedTaskId, selectedTask, setParams]);
  const taskQuery = useQuery({
    queryKey: ['task', selectedTask?.id],
    queryFn: () => api.task(selectedTask!.id),
    enabled: Boolean(selectedTask),
    refetchInterval: (query) => {
      const current = query.state.data as TaskDetail | undefined;
      return ['queued', 'running', 'awaiting_approval'].includes(current?.status ?? '') || current?.artifacts?.some((artifact) => !['ready', 'failed', 'skipped'].includes(artifact.status)) ? 2_500 : false;
    },
  });
  const workflowRunId = taskQuery.data?.workflow_run_id ?? selectedTask?.workflow_run_id;
  const workflowQuery = useQuery({
    queryKey: ['workflow-run', workflowRunId],
    queryFn: () => api.workflowRun(workflowRunId!),
    enabled: Boolean(workflowRunId),
    refetchInterval: (query) => ['queued', 'running', 'awaiting_approval'].includes((query.state.data as WorkflowRun | undefined)?.status ?? '') ? 2_500 : false,
  });
  useEffect(() => {
    const cause = taskQuery.error ?? workflowQuery.error;
    if (cause) reportError(cause instanceof Error ? cause.message : 'Could not load live execution state');
  }, [reportError, taskQuery.error, workflowQuery.error]);
  const execution = useMemo(() => buildExecution(agent, data.agents, tasks, taskQuery.data, workflowQuery.data), [agent, data.agents, tasks, taskQuery.data, workflowQuery.data]);
  const sectionParam = params.get('section') as AgentSection | null;
  const filterParam = params.get('activity') as ActivityFilter | null;
  const update = (changes: Record<string, string | undefined>, replace = false) => {
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key));
    setParams(next, { replace });
  };
  const value: ExecutionContextValue = {
    ...execution,
    section: sectionParam && sections.includes(sectionParam) ? sectionParam : 'overview',
    selectedStepId: params.get('step') ?? execution.currentStepId,
    selectedEventId: params.get('event') ?? undefined,
    activityFilter: filterParam && filters.includes(filterParam) ? filterParam : 'all',
    taskLoading: taskQuery.isLoading,
    workflowLoading: workflowQuery.isLoading,
    setSection: (section) => update({ section, event: undefined }),
    selectTask: (taskId, section = 'workspace') => update({ task: taskId, section, step: undefined, event: undefined }),
    selectStep: (stepId) => update({ step: stepId, event: undefined }),
    selectEvent: (eventId, stepId) => update({ event: eventId, step: stepId }),
    setActivityFilter: (filter) => update({ activity: filter }, true),
    refresh: async () => { await Promise.all([taskQuery.refetch(), workflowRunId ? workflowQuery.refetch() : Promise.resolve()]); },
  };
  return <AgentExecutionContext.Provider value={value}>{children}</AgentExecutionContext.Provider>;
}

export function useAgentExecution() {
  const value = useContext(AgentExecutionContext);
  if (!value) throw new Error('useAgentExecution must be used inside AgentExecutionProvider');
  return value;
}
