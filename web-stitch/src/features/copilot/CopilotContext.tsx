/* oxlint-disable react/only-export-components -- provider and hook intentionally share one context module */
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

export type CopilotLaunchContext = {
  taskId: string;
  outputDocumentId: string;
  workflowRunId?: string;
  workflowId?: string;
};

type CopilotContextValue = {
  open: boolean;
  context: CopilotLaunchContext | null;
  openCopilot: (context: CopilotLaunchContext) => void;
  closeCopilot: () => void;
};

const Context = createContext<CopilotContextValue | null>(null);

export function CopilotContextProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; context: CopilotLaunchContext | null }>({
    open: false,
    context: null,
  });
  const value = useMemo<CopilotContextValue>(() => ({
    ...state,
    openCopilot: (context) => setState({ open: true, context }),
    closeCopilot: () => setState((current) => ({ ...current, open: false })),
  }), [state]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useCopilotContext(): CopilotContextValue {
  const value = useContext(Context);
  if (!value) throw new Error('useCopilotContext must be used inside CopilotContextProvider');
  return value;
}
