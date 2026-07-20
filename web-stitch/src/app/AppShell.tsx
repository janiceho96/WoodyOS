import { Activity, BarChart3, Blocks, Bot, BookOpen, Boxes, CircleHelp, LayoutDashboard, LogOut, Menu, Moon, RefreshCw, Search, Settings, Sun, WandSparkles, Workflow, Wrench, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, auth, type Onboarding, type Session } from '../api';
import { Modal, Notice } from '../components/ui';
import { BrandMark } from '../components/BrandMark';
import { TaskDialogBody } from '../features/execution/ExecutionPage';
import { TextDocumentDialogBody } from '../features/knowledge/KnowledgePage';
import { OnboardingFlow } from '../features/onboarding/Onboarding';
import { ToolDialogBody } from '../features/tools/ToolsPage';
import { WoodyChat } from '../features/copilot/WoodyChat';
import type { Theme } from './theme';
import { WorkspaceContext, useWorkspaceData } from './workspace';

export type AppDialog = 'task' | 'document' | 'tool' | 'search' | null;

const nav = [
  { path: '/dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { path: '/agents', label: 'Agents', Icon: Bot },
  { path: '/agents/new', label: 'Builder', Icon: WandSparkles },
  { path: '/solutions', label: 'Starter Solutions', Icon: Boxes },
  { path: '/workflows', label: 'Workflows', Icon: Workflow },
  { path: '/knowledge', label: 'Knowledge Base', Icon: BookOpen },
  { path: '/tools', label: 'Tools', Icon: Wrench },
  { path: '/mcp', label: 'MCP Marketplace', Icon: Blocks },
  { path: '/executions', label: 'Logs', Icon: Activity },
  { path: '/analytics', label: 'Analytics', Icon: BarChart3 },
];

export function AppShell({ session, setSession, theme, setTheme, toggleTheme }: {
  session: Session; setSession: (session: Session | null) => void; theme: Theme; setTheme: (theme: Theme) => void; toggleTheme: () => void;
}) {
  const workspace = useWorkspaceData();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dialog, setDialog] = useState<AppDialog>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [onboarding, setOnboarding] = useState<Onboarding>(session.user.onboarding);
  const [showOnboarding, setShowOnboarding] = useState(!session.user.onboarding.completed);
  const data = workspace.data ?? { agents: [], tasks: [], workflows: [], documents: [], tools: [] };
  const label = nav.find((item) => location.pathname === item.path || (item.path === '/agents' && location.pathname.startsWith('/agents/')))?.label ?? (location.pathname === '/settings' ? 'Settings' : location.pathname === '/mascot-lab' ? 'Mascot Lab' : 'Woody Workspace');
  const report = (message: string) => { setNotice(message); setError(''); };
  const reportError = (message: string) => { setError(message); setNotice(''); };
  const value = useMemo(() => ({
    session, data, loading: workspace.isFetching, refresh: workspace.refetch, notice, error, report, reportError,
    clearMessage: () => { setNotice(''); setError(''); },
    signOut: () => { auth.clear(); setSession(null); },
    openOnboarding: () => setShowOnboarding(true),
  }), [session, data, workspace.isFetching, notice, error]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setDialog('search'); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, []);
  const go = (path: string) => { navigate(path); setMobileOpen(false); };

  return <WorkspaceContext.Provider value={value}>
    <div className="app-shell">
      <aside className={`side-rail ${mobileOpen ? 'open' : ''}`}>
        <div className="brand-block"><BrandMark/><div><strong>Woody</strong><small>Agent OS</small></div><button className="icon-button mobile-only" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={19}/></button></div>
        <nav className="primary-nav" aria-label="Primary navigation">{nav.map(({ path, label: itemLabel, Icon }) => <button key={path} className={location.pathname === path || (path === '/agents' && location.pathname.startsWith('/agents/') && location.pathname !== '/agents/new') ? 'active' : ''} onClick={() => go(path)}><Icon size={19}/><span>{itemLabel}</span></button>)}</nav>
        <div className="rail-footer"><button className={location.pathname === '/settings' ? 'active' : ''} onClick={() => go('/settings')}><Settings size={19}/><span>Settings</span></button><div className="identity-card"><span className="avatar">{session.user.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{session.user.displayName}</strong><small>{session.workspace.name}</small></div><button className="icon-button" aria-label="Sign out" title="Sign out" onClick={() => value.signOut()}><LogOut size={16}/></button></div></div>
      </aside>
      <div className="workspace">
        <header className="top-nav"><button className="icon-button mobile-only" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={20}/></button><div className="workspace-title"><span>{label}</span><small>{workspace.isFetching ? 'Syncing live data…' : 'Woody Workspace'}</small></div><button className="global-search" onClick={() => setDialog('search')} aria-label="Search workspace"><Search size={17}/><span>Search commands, agents, logs…</span><kbd>⌘K</kbd></button><div className="top-actions"><button className="icon-button" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>{theme === 'dark' ? <Sun size={18}/> : <Moon size={18}/>}</button><a className="icon-button" href="/docs" target="_blank" rel="noreferrer" aria-label="Open API documentation"><CircleHelp size={18}/></a><button className="icon-button" onClick={() => void workspace.refetch()} aria-label="Refresh workspace"><RefreshCw size={18} className={workspace.isFetching ? 'spin' : ''}/></button><span className="avatar small">{session.user.displayName.slice(0, 1).toUpperCase()}</span></div></header>
        <main className="page-canvas"><Notice text={error || notice} error={Boolean(error)} dismiss={() => { setError(''); setNotice(''); }}/>{workspace.error && <Notice text={workspace.error instanceof Error ? workspace.error.message : 'Could not load workspace data'} error dismiss={() => void workspace.refetch()}/>}<Outlet context={{ openDialog: setDialog, theme, setTheme, onboarding, resumeOnboarding: () => setShowOnboarding(true), restartOnboarding: async () => { const next = await api.restartOnboarding(); setOnboarding(next); setShowOnboarding(true); report('Onboarding restarted'); } }}/></main>
      </div>
    </div>
    {dialog === 'task' && <Modal title="Initiate task" close={() => setDialog(null)}><TaskDialogBody close={() => setDialog(null)}/></Modal>}
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
  useEffect(() => { inputRef.current?.focus(); }, []);
  if (!data) return null;
  const normalized = query.toLowerCase().trim();
  const results = [
    ...nav.map((item) => ({ title: item.label, detail: 'Open workspace page', path: item.path, kind: 'Command' })),
    ...data.agents.map((agent) => ({ title: agent.name, detail: `${agent.role} · ${agent.status}`, path: `/agents?selected=${agent.id}`, kind: 'Agent' })),
    ...data.tasks.map((task) => ({ title: task.title, detail: `${task.agent_name ?? 'Agent'} · ${task.status}`, path: `/executions?task=${task.id}`, kind: 'Execution' })),
    ...data.documents.map((doc) => ({ title: doc.name, detail: `${doc.source_type} · ${doc.status}`, path: '/knowledge', kind: 'Knowledge' })),
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
