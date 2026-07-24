import type { Agent, Task } from '../../api';

export type AgentDisplayStatus = 'ready' | 'working' | 'draft' | 'paused' | 'needs_attention' | 'archived';

const activeTaskStatuses = new Set<Task['status']>(['queued', 'running', 'awaiting_approval']);

function latestAgentTask(agentId: string, tasks: Task[]) {
  return tasks
    .filter((task) => task.agent_id === agentId)
    .reduce<Task | undefined>((latest, task) => !latest || Date.parse(task.updated_at) > Date.parse(latest.updated_at) ? task : latest, undefined);
}

export function agentDisplayStatus(agent: Agent, tasks: Task[]): AgentDisplayStatus {
  if (agent.status === 'archived') return 'archived';
  if (agent.status === 'draft') return 'draft';
  if (agent.status === 'paused') return 'paused';
  const latest = latestAgentTask(agent.id, tasks);
  if (latest && activeTaskStatuses.has(latest.status)) return 'working';
  if (latest?.status === 'failed') return 'needs_attention';
  return 'ready';
}

export function agentStatusDescription(status: AgentDisplayStatus) {
  if (status === 'working') return 'Currently completing a task';
  if (status === 'draft') return 'Publish this draft before running it';
  if (status === 'paused') return 'Resume this agent to make it selectable';
  if (status === 'needs_attention') return 'The latest task failed; review its output';
  if (status === 'archived') return 'Archived and unavailable for new work';
  return 'Published and ready for a new task';
}

export function agentAvatarStatus(status: AgentDisplayStatus) {
  if (status === 'working') return 'busy';
  if (status === 'ready') return 'active';
  if (status === 'needs_attention') return 'error';
  return 'offline';
}
