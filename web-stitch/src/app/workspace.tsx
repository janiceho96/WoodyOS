import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Agent, type AiQuotaStatus, type Analytics, type Document, type RuntimeConfig, type Session, type Task, type Tool, type Workflow } from '../api';

export type WorkspaceData = {
  analytics?: Analytics;
  runtime?: RuntimeConfig;
  quota?: AiQuotaStatus;
  agents: Agent[];
  tasks: Task[];
  workflows: Workflow[];
  documents: Document[];
  tools: Tool[];
};

const empty: WorkspaceData = { agents: [], tasks: [], workflows: [], documents: [], tools: [] };

export function useWorkspaceData(enabled = true) {
  return useQuery({
    queryKey: ['workspace'],
    enabled,
    refetchInterval: 15_000,
    queryFn: async (): Promise<WorkspaceData> => {
      const [analytics, runtime, quota, agents, tasks, workflows, documents, tools] = await Promise.all([
        api.analytics(), api.runtimeConfig(), api.aiQuota(), api.agents(), api.tasks(), api.workflows(), api.documents(), api.tools(),
      ]);
      return { analytics, runtime, quota, agents: agents.data, tasks: tasks.data, workflows: workflows.data, documents: documents.data, tools: tools.data };
    },
    placeholderData: empty,
  });
}

export type WorkspaceContextValue = {
  session: Session;
  data: WorkspaceData;
  loading: boolean;
  refresh: () => Promise<unknown>;
  notice: string;
  error: string;
  report: (message: string) => void;
  reportError: (message: string) => void;
  clearMessage: () => void;
  signOut: () => void;
  openOnboarding: () => void;
};

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceContext');
  return value;
}
