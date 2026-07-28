import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { api, auth, type Session } from './api';
import { AppShell, type ShellOutlet } from './app/AppShell';
import { resolveLegacyResourcePath } from './app/navigation';
import { useTheme } from './app/theme';
import { BrandMark } from './components/BrandMark';
import { AuthPage } from './features/auth/AuthPage';
import { ExecutionPage } from './features/execution/ExecutionPage';
import { KnowledgePage } from './features/knowledge/KnowledgePage';
import { ApiToolsPage } from './features/tools/ApiToolsPage';
const McpMarketplacePage = lazy(() => import('./features/mcp/McpMarketplacePage').then((module) => ({ default: module.McpMarketplacePage })));
const AgentBuilderPage = lazy(() => import('./features/agents/AgentBuilderPage').then((module) => ({ default: module.AgentBuilderPage })));
const AgentsPage = lazy(() => import('./features/agents/AgentsPage').then((module) => ({ default: module.AgentsPage })));
const DepartmentPage = lazy(() => import('./features/departments/DepartmentPage').then((module) => ({ default: module.DepartmentPage })));
const AgentWorkspacePage = lazy(() => import('./features/agents/AgentWorkspacePage').then((module) => ({ default: module.AgentWorkspacePage })));
const AnalyticsPage = lazy(() => import('./features/analytics/AnalyticsPage').then((module) => ({ default: module.AnalyticsPage })));
const DashboardPage = lazy(() => import('./features/dashboard/DashboardPage').then((module) => ({ default: module.DashboardPage })));
const SettingsPage = lazy(() => import('./features/settings/SettingsPage').then((module) => ({ default: module.SettingsPage })));
const WorkflowsPage = lazy(() => import('./features/workflows/WorkflowsPage').then((module) => ({ default: module.WorkflowsPage })));
const StarterSolutionsPage = lazy(() => import('./features/solutions/StarterSolutionsPage').then((module) => ({ default: module.StarterSolutionsPage })));
const MascotLabPage = lazy(() => import('./features/mascot/MascotLabPage').then((module) => ({ default: module.MascotLabPage })));
const MemoryPage = lazy(() => import('./features/memory/MemoryPage').then((module) => ({ default: module.MemoryPage })));

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1 } } });

function RoutedApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(Boolean(auth.get()));
  const { theme, setTheme, toggleTheme, accentColor, setAccentColor } = useTheme();
  useEffect(() => {
    if (!auth.get()) { setChecking(false); return; }
    api.me().then((me) => setSession({ accessToken: auth.get(), user: { id: me.id, email: me.email, displayName: me.display_name, onboarding: me.onboarding }, workspace: { id: me.workspace_id, name: me.workspace_name, role: me.role } })).catch(() => auth.clear()).finally(() => setChecking(false));
  }, []);
  if (checking) return <div className="boot-screen"><BrandMark/><strong>Starting Woody…</strong></div>;
  if (!session) return <AuthPage theme={theme} toggleTheme={toggleTheme} onSession={(next) => { auth.set(next.accessToken); queryClient.clear(); setSession(next); }}/>;
  return <Suspense fallback={<div className="boot-screen"><BrandMark/><strong>Loading Woody workspace…</strong></div>}><Routes><Route element={<AppShell session={session} setSession={(next) => { if (!next) queryClient.clear(); setSession(next); }} theme={theme} setTheme={setTheme} toggleTheme={toggleTheme}/>}> 
    <Route index element={<Navigate to="/dashboard" replace/>}/>
    <Route path="/dashboard" element={<DashboardRoute/>}/>
    <Route path="/agents" element={<AgentsPage/>}/>
    <Route path="/agents/library" element={<StarterSolutionsPage/>}/>
    <Route path="/agents/new" element={<AgentBuilderPage/>}/>
    <Route path="/agents/:agentId/edit" element={<AgentBuilderPage/>}/>
    <Route path="/agents/:agentId" element={<AgentWorkspacePage/>}/>
    <Route path="/departments" element={<DepartmentPage/>}/>
    <Route path="/executions" element={<ExecutionRoute/>}/>
    <Route path="/workflows" element={<WorkflowsPage/>}/>
    <Route path="/solutions" element={<StarterSolutionsPage/>}/>
    <Route path="/knowledge" element={<KnowledgeRoute/>}/>
    <Route path="/knowledge/memory" element={<MemoryPage/>}/>
    <Route path="/api-tools" element={<ApiToolsRoute/>}/>
    <Route path="/tools" element={<LegacyToolsRedirect/>}/>
    <Route path="/mcp" element={<McpMarketplacePage/>}/>
    <Route path="/analytics" element={<AnalyticsPage/>}/>
    <Route path="/settings" element={<SettingsRoute accentColor={accentColor} setAccentColor={setAccentColor}/>}/>
    <Route path="/mascot-lab" element={<MascotLabPage/>}/>
    <Route path="*" element={<Navigate to="/dashboard" replace/>}/>
  </Route></Routes></Suspense>;
}

function DashboardRoute() { const { openDialog } = useOutletContext<ShellOutlet>(); const navigate = useNavigate(); return <DashboardPage openTask={() => openDialog('task')} openAgent={() => navigate('/agents/new')}/>; }
function ExecutionRoute() { const { openDialog } = useOutletContext<ShellOutlet>(); return <ExecutionPage openTask={() => openDialog('task')}/>; }
function KnowledgeRoute() { const { openDialog } = useOutletContext<ShellOutlet>(); return <KnowledgePage openText={() => openDialog('document')}/>; }
function ApiToolsRoute() { const { openDialog } = useOutletContext<ShellOutlet>(); return <ApiToolsPage openConnect={() => openDialog('tool')}/>; }
function LegacyToolsRedirect() { const location = useLocation(); return <Navigate to={resolveLegacyResourcePath(`${location.pathname}${location.search}${location.hash}`)} replace/>; }
function SettingsRoute({ accentColor, setAccentColor }: { accentColor: string; setAccentColor: (color: string) => void }) { const { theme, setTheme, onboarding, resumeOnboarding, restartOnboarding } = useOutletContext<ShellOutlet>(); return <SettingsPage theme={theme} setTheme={setTheme} accentColor={accentColor} setAccentColor={setAccentColor} onboarding={onboarding} resume={resumeOnboarding} restart={() => void restartOnboarding()}/>; }

export default function App() {
  return <QueryClientProvider client={queryClient}><BrowserRouter><RoutedApp/></BrowserRouter></QueryClientProvider>;
}
