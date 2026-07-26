import { Activity, BarChart3, Bot, BookOpen, Building2, CircleHelp, LayoutDashboard, LogOut, Menu, Minus, Moon, Plus, PlugZap, RefreshCw, Search, Settings, Sun, Workflow, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, auth, isApiTool, type Onboarding, type Session } from '../api';
import { Modal, Notice } from '../components/ui';
import { BrandMark } from '../components/BrandMark';
import { TaskDialogBody } from '../features/execution/ExecutionPage';
import { TextDocumentDialogBody } from '../features/knowledge/KnowledgePage';
import { OnboardingFlow } from '../features/onboarding/Onboarding';
import { ToolDialogBody } from '../features/tools/ToolsPage';
import { WoodyChat } from '../features/copilot/WoodyChat';
import { AgentWorkspaceNav } from '../features/agents/AgentWorkspaceNav';
import type { Theme } from './theme';
import { primaryNavigation } from './navigation';
import { WorkspaceContext, useWorkspaceData, type NoticeAction, type WorkspaceData } from './workspace';

export type AppDialog = 'task' | 'document' | 'tool' | 'search' | null;

const nav = [
  { path: '/dashboard', label: 'Home', Icon: LayoutDashboard, group: 'Workspace' },
  { path: '/agents', label: 'Agents', Icon: Bot, group: 'Build' },
  { path: '/departments', label: 'Department', Icon: Building2, group: 'Build' },
  { path: '/workflows', label: 'Workflows', Icon: Workflow, group: 'Build' },
  { path: '/knowledge', label: 'Knowledge', Icon: BookOpen, group: 'Resources' },
  { path: '/api-tools', label: 'API Tools', Icon: PlugZap, group: 'Resources' },
  { path: '/mcp', label: 'MCP', Icon: PlugZap, group: 'Resources' },
  { path: '/executions', label: 'Outputs', Icon: Activity, group: 'Activity' },
  { path: '/analytics', label: 'Analytics', Icon: BarChart3, group: 'Activity' },
];

const emptyWorkspaceData: WorkspaceData = { agents: [], tasks: [], workflows: [], documents: [], tools: [] };
const workspaceZoomKey = 'woody.workspaceZoom';
const minimumWorkspaceZoom = 80;
const maximumWorkspaceZoom = 120;

export type ResourceSearchDomain = 'api' | 'mcp-connection' | 'mcp-action';

// oxlint-disable-next-line react/only-export-components -- the user-facing resource naming contract is intentionally testable.
export function resourceSearchKind({ domain }: { domain: ResourceSearchDomain }) {
  if (domain === 'api') return 'API Tool';
  if (domain === 'mcp-connection') return 'MCP Connection';
  return 'MCP Action';
}

function initialWorkspaceZoom() {
  try {
    const stored = Number(window.localStorage.getItem(workspaceZoomKey));
    return Number.isFinite(stored) && stored >= minimumWorkspaceZoom && stored <= maximumWorkspaceZoom ? stored : 100;
  } catch {
    return 100;
  }
}

export function AppShell({ session, setSession, theme, setTheme, toggleTheme }: {
  session: Session; setSession: (session: Session | null) => void; theme: Theme; setTheme: (theme: Theme) => void; toggleTheme: () => void;
}) {
  const workspace = useWorkspaceData();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dialog, setDialog] = useState<AppDialog>(null);
  const [notice, setNotice] = useState('');
  const [noticeAction, setNoticeAction] = useState<NoticeAction>();
  const [error, setError] = useState('');
  const [onboarding, setOnboarding] = useState<Onboarding>(session.user.onboarding);
  const [showOnboarding, setShowOnboarding] = useState(!session.user.onboarding.completed);
  const [workspaceZoom, setWorkspaceZoom] = useState(initialWorkspaceZoom);
  const data = workspace.data ?? emptyWorkspaceData;
  const agentWorkspaceMatch = location.pathname === '/agents/library' ? null : location.pathname.match(/^\/agents\/([^/]+)$/);
  const workspaceAgent = agentWorkspaceMatch ? data.agents.find((agent) => agent.id === agentWorkspaceMatch[1]) : undefined;
  const label = workspaceAgent?.name ?? nav.find((item) => location.pathname === item.path || (item.path === '/agents' && location.pathname.startsWith('/agents/')))?.label ?? primaryNavigation.find((item) => location.pathname === item.path)?.label ?? (location.pathname === '/solutions' ? 'Create' : location.pathname === '/settings' ? 'Settings' : location.pathname === '/mascot-lab' ? 'Mascot Lab' : 'Woody Workspace');
  const liveWork = data.tasks.filter((task) => ['queued', 'running'].includes(task.status));
  const report = useCallback((message: string, action?: NoticeAction) => { setNotice(message); setNoticeAction(action); setError(''); }, []);
  const reportError = useCallback((message: string) => { setError(message); setNotice(''); setNoticeAction(undefined); }, []);
  const value = useMemo(() => ({
    session, data, loading: workspace.isFetching, refresh: workspace.refetch, notice, error, report, reportError,
    clearMessage: () => { setNotice(''); setNoticeAction(undefined); setError(''); },
    signOut: () => { auth.clear(); setSession(null); },
    openOnboarding: () => setShowOnboarding(true),
  }), [session, data, workspace.isFetching, workspace.refetch, notice, error, report, reportError, setSession]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setDialog('search'); }
      if (event.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(workspaceZoomKey, String(workspaceZoom));
    } catch {
      // The zoom still works for this session when browser storage is unavailable.
    }
  }, [workspaceZoom]);
  const go = (path: string) => { navigate(path); setMobileOpen(false); };
  const zoomStyle = {
    zoom: workspaceZoom / 100,
    width: `${100 / (workspaceZoom / 100)}%`,
  } as CSSProperties;

  return <WorkspaceContext.Provider value={value}>
    <div className="app-shell">
      <aside id="primary-navigation" className={`side-rail ${mobileOpen ? 'open' : ''}`}>
        <div className="brand-block">
          <button type="button" className="brand-home-link" onClick={() => go('/dashboard')} aria-label="Go to Woody home">
            <BrandMark/><span><strong>Woody</strong><small>Agent OS</small></span>
          </button>
          <button className="icon-button mobile-only" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={19}/></button>
        </div>
        {agentWorkspaceMatch ? <AgentWorkspaceNav agentId={agentWorkspaceMatch[1]} close={() => setMobileOpen(false)}/> : <nav className="primary-nav simplified" aria-label="Primary navigation">{primaryNavigation.map((item) => {
          const active = location.pathname === item.path || (item.id === 'agents' && location.pathname.startsWith('/agents/'));
          return <div className="primary-nav-item" key={item.id}><button className={active ? 'active' : ''} aria-current={active ? 'page' : undefined} onClick={() => go(item.path)}><item.Icon size={18}/><span>{item.label}</span>{item.id === 'outputs' && liveWork.length > 0 && <b>{liveWork.length}</b>}</button></div>;
        })}</nav>}
        <div className="rail-footer"><button className={location.pathname === '/analytics' ? 'active' : ''} aria-current={location.pathname === '/analytics' ? 'page' : undefined} onClick={() => go('/analytics')}><BarChart3 size={19}/><span>Analytics</span></button><button className={location.pathname === '/settings' ? 'active' : ''} aria-current={location.pathname === '/settings' ? 'page' : undefined} onClick={() => go('/settings')}><Settings size={19}/><span>Settings</span></button><div className="identity-card"><span className="avatar">{session.user.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{session.user.displayName}</strong><small>{session.workspace.name}</small></div><button className="icon-button" aria-label="Sign out" title="Sign out" onClick={() => value.signOut()}><LogOut size={16}/></button></div></div>
      </aside>
      {mobileOpen && <button type="button" className="mobile-nav-backdrop" onClick={() => setMobileOpen(false)} aria-label="Close navigation"/>}
      <div className="workspace">
        <header className="top-nav"><button className="icon-button mobile-only" onClick={() => setMobileOpen(true)} aria-label="Open navigation" aria-expanded={mobileOpen} aria-controls="primary-navigation"><Menu size={20}/></button><div className="workspace-title"><span>{label}</span><small>{workspace.isFetching ? 'Syncing live data…' : workspaceAgent ? 'Agent command center' : 'Woody Workspace'}</small></div><button className="global-search" onClick={() => setDialog('search')} aria-label="Search workspace"><Search size={17}/><span>Search agents, outputs, knowledge…</span><kbd>⌘K</kbd></button><div className="top-actions">{liveWork.length > 0 && <button className="live-work-pill" onClick={() => { const task = liveWork[0]; go(`/agents/${task.agent_id}?section=workspace&task=${task.id}`); }}><i/>{liveWork.length} active</button>}<div className="workspace-zoom-controls" role="group" aria-label="Workspace zoom"><button type="button" onClick={() => setWorkspaceZoom((current) => Math.max(minimumWorkspaceZoom, current - 10))} disabled={workspaceZoom === minimumWorkspaceZoom} aria-label="Zoom out workspace"><Minus size={14}/></button><button type="button" className="workspace-zoom-value" onClick={() => setWorkspaceZoom(100)} aria-label={`Reset workspace zoom. Current zoom ${workspaceZoom}%`}>{workspaceZoom}%</button><button type="button" onClick={() => setWorkspaceZoom((current) => Math.min(maximumWorkspaceZoom, current + 10))} disabled={workspaceZoom === maximumWorkspaceZoom} aria-label="Zoom in workspace"><Plus size={14}/></button></div><button className="icon-button" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>{theme === 'dark' ? <Sun size={18}/> : <Moon size={18}/>}</button><a className="icon-button" href="/docs" target="_blank" rel="noreferrer" aria-label="Open help and API documentation"><CircleHelp size={18}/></a><button className="icon-button" onClick={() => void workspace.refetch()} aria-label="Refresh workspace"><RefreshCw size={18} className={workspace.isFetching ? 'spin' : ''}/></button><span className="avatar small">{session.user.displayName.slice(0, 1).toUpperCase()}</span></div></header>
        <main className={`page-canvas ${agentWorkspaceMatch ? 'agent-workspace-canvas' : ''}`}><Notice text={error || notice} error={Boolean(error)} action={error ? undefined : noticeAction} dismiss={() => { setError(''); setNotice(''); setNoticeAction(undefined); }}/>{workspace.error && <Notice text={workspace.error instanceof Error ? workspace.error.message : 'Could not load workspace data'} error dismiss={() => void workspace.refetch()}/>}<div className="workspace-zoom-surface" style={zoomStyle}><Outlet context={{ openDialog: setDialog, theme, setTheme, onboarding, resumeOnboarding: () => setShowOnboarding(true), restartOnboarding: async () => { const next = await api.restartOnboarding(); setOnboarding(next); setShowOnboarding(true); report('Onboarding restarted'); } }}/></div></main>
      </div>
    </div>
    {dialog === 'task' && <Modal title="Initiate task" close={() => setDialog(null)}><TaskDialogBody close={() => setDialog(null)} onCreated={(task) => go(`/agents/${task.agent_id}?section=workspace&task=${task.id}`)}/></Modal>}
    {dialog === 'document' && <Modal title="Add text knowledge" close={() => setDialog(null)}><TextDocumentDialogBody close={() => setDialog(null)}/></Modal>}
    {dialog === 'tool' && <Modal title="Connect API tool" close={() => setDialog(null)}><ToolDialogBody close={() => setDialog(null)}/></Modal>}
    {dialog === 'search' && <WorkspaceSearch close={() => setDialog(null)} go={(path) => { setDialog(null); go(path); }} data={data}/>}
    {showOnboarding && !onboarding.completed && <OnboardingFlow state={onboarding} storageKey={`nexus_onboarding_${session.user.id}_v${onboarding.version}`} agents={data.agents} tasks={data.tasks} onPause={() => setShowOnboarding(false)} onCreateAgent={() => { setShowOnboarding(false); go('/agents/new'); }} onUpdate={(next) => { setOnboarding(next); setSession({ ...session, user: { ...session.user, onboarding: next } }); if (next.completed) setShowOnboarding(false); }} onPage={go}/>} 
    <WoodyChat displayName={session.user.displayName}/>
  </WorkspaceContext.Provider>;
}

function WorkspaceSearch({ data, close, go }: { data: ReturnType<typeof useWorkspaceData>['data'] extends infer T ? NonNullable<T> : never; close: () => void; go: (path: string) => void }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const resourceCatalog = useQuery({
    queryKey: ['workspace-search-resource-catalog'],
    queryFn: async () => {
      const [connections, workflowResources] = await Promise.all([api.mcpConnections(), api.workflowResources()]);
      return { connections: connections.data, mcpActions: workflowResources.mcpTools };
    },
  });
  useEffect(() => { inputRef.current?.focus(); }, []);
  if (!data) return null;
  const normalized = query.toLowerCase().trim();
  const results = [
    ...nav.map((item) => ({ title: item.label, detail: 'Open workspace page', path: item.path, kind: 'Command' })),
    ...data.agents.map((agent) => ({ title: agent.name, detail: `${agent.role} · ${agent.status}`, path: `/agents/${agent.id}`, kind: 'Agent' })),
    ...data.tasks.map((task) => ({ title: task.title, detail: `${task.agent_name ?? 'Agent'} · ${task.status}`, path: `/agents/${task.agent_id}?section=workspace&task=${task.id}`, kind: 'Output' })),
    ...data.documents.map((doc) => ({ title: doc.name, detail: `${doc.source_type} · ${doc.status}`, path: '/knowledge', kind: 'Knowledge' })),
    ...data.tools.filter(isApiTool).map((tool) => ({ title: tool.name, detail: tool.description || tool.permissions.join(', ') || 'API Tool', path: '/api-tools', kind: resourceSearchKind({ domain: 'api' }) })),
    ...(resourceCatalog.data?.connections ?? []).map((connection) => ({ title: connection.name, detail: connection.description || `${connection.tool_count ?? 0} actions`, path: `/mcp?tab=access&connection=${encodeURIComponent(connection.id)}`, kind: resourceSearchKind({ domain: 'mcp-connection' }) })),
    ...(resourceCatalog.data?.mcpActions ?? []).map((action) => ({ title: action.title || action.remoteName, detail: `${action.connectionName} · ${action.description || action.remoteName}`, path: `/mcp?tab=access&connection=${encodeURIComponent(action.connectionId)}`, kind: resourceSearchKind({ domain: 'mcp-action' }) })),
  ].filter((item) => !normalized || `${item.title} ${item.detail} ${item.kind}`.toLowerCase().includes(normalized)).slice(0, 12);
  return <Modal title="Search workspace" close={close} wide><div className="search-dialog"><label><Search size={18}/><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search commands, agents, executions, knowledge…"/></label><div>{results.map((result, index) => <button key={`${result.kind}-${result.title}-${index}`} onClick={() => go(result.path)}><span>{result.kind}</span><div><strong>{result.title}</strong><small>{result.detail}</small></div><Activity size={15}/></button>)}{!results.length && <div className="empty-state"><strong>No results</strong><p>Try another name, status, or command.</p></div>}</div></div></Modal>;
}

export type ShellOutlet = {
  openDialog: (dialog: AppDialog) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  onboarding: Onboarding;
  resumeOnboarding: () => void;
  restartOnboarding: () => Promise<void>;
};
