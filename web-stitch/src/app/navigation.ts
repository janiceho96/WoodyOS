import { Activity, Bot, BookOpen, Braces, Blocks, Building2, LayoutDashboard, Workflow } from 'lucide-react';

export const primaryNavigation = [
  { id: 'home', path: '/dashboard', label: 'Home', Icon: LayoutDashboard },
  { id: 'agents', path: '/agents', label: 'Agents', Icon: Bot },
  { id: 'departments', path: '/departments', label: 'Department', Icon: Building2 },
  { id: 'workflows', path: '/workflows', label: 'Workflows', Icon: Workflow },
  { id: 'outputs', path: '/executions', label: 'Outputs', Icon: Activity },
  { id: 'knowledge', path: '/knowledge', label: 'Knowledge', Icon: BookOpen },
  { id: 'mcp', path: '/mcp', label: 'MCP', Icon: Blocks },
  { id: 'api-tools', path: '/api-tools', label: 'API Tools', Icon: Braces },
] as const;

export function resolveLegacyResourcePath(path: string) {
  return path === '/tools' || path.startsWith('/tools?') || path.startsWith('/tools#') ? path.replace('/tools', '/api-tools') : path;
}
