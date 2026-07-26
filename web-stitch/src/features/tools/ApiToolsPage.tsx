import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, BriefcaseBusiness, CheckCircle2, Code2, FileSearch, Globe2, LoaderCircle, Plus, Search, ShieldCheck, Unplug, Wrench } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { api, isApiTool, type ApiTool } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { EmptyState, PageHeader, Status } from '../../components/ui';
import { handleTabListKeyDown } from '../../lib/a11y';
import { DemoApiGallery, JobSearchPanel, WebResearchPanel } from './ToolsPage';
import './api-tools.css';
import './web-research.css';

// oxlint-disable-next-line react/only-export-components -- the navigation contract is intentionally testable.
export const API_TOOL_SECTIONS = [
  { id: 'installed', label: 'Installed' },
  { id: 'add', label: 'Add API' },
  { id: 'providers', label: 'Providers' },
  { id: 'activity', label: 'Activity' },
] as const;

type ApiToolSection = (typeof API_TOOL_SECTIONS)[number]['id'];

function sectionFromQuery(value: string | null): ApiToolSection {
  if (value === 'add' || value === 'custom' || value === 'apps') return 'add';
  if (value === 'providers' || value === 'web' || value === 'jobs') return 'providers';
  if (value === 'activity') return 'activity';
  return 'installed';
}

export function ApiToolsPage({ openConnect }: { openConnect: () => void }) {
  const { data, report, reportError } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const section = sectionFromQuery(params.get('section'));
  const tools = data.tools.filter(isApiTool);
  const activeTools = tools.filter((tool) => tool.enabled).length;
  const test = useMutation({
    mutationFn: (tool: ApiTool) => api.testTool(tool.id).then(() => tool),
    onSuccess: (tool) => report(`${tool.name} connection is healthy`),
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Tool health test failed'),
  });
  const toggle = useMutation({
    mutationFn: (tool: ApiTool) => api.updateTool(tool.id, { enabled: !tool.enabled }).then(() => tool),
    onSuccess: async (tool) => {
      report(`${tool.name} ${tool.enabled ? 'disabled' : 'enabled'}`);
      await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not update tool'),
  });
  const setSection = (next: ApiToolSection) => setParams(next === 'installed' ? {} : { section: next });

  return <div className="tools-page api-tools-page">
    <PageHeader eyebrow="Resources" title="API Tools" description="Connect HTTPS endpoints and read-only providers that agents may call." actions={<button className="button primary" onClick={openConnect}><Plus size={15}/>Custom API</button>}/>
    <section className="api-tools-safety"><ShieldCheck size={20}/><div><strong>Connections stay private and off by default</strong><p>Credentials are encrypted by Woody’s backend. Agents receive only the APIs and permissions you allow.</p></div><span>{activeTools} active API tool{activeTools === 1 ? '' : 's'}</span></section>
    <div className="api-tool-sections" role="tablist" aria-label="API Tool sections" onKeyDown={handleTabListKeyDown}>{API_TOOL_SECTIONS.map((item) => <button key={item.id} id={`api-tools-tab-${item.id}`} type="button" role="tab" aria-selected={section === item.id} aria-controls={`api-tools-panel-${item.id}`} tabIndex={section === item.id ? 0 : -1} className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)}>{item.id === 'installed' ? <CheckCircle2 size={15}/> : item.id === 'add' ? <Code2 size={15}/> : item.id === 'providers' ? <Globe2 size={15}/> : <Activity size={15}/>} {item.label}{item.id === 'installed' && <span>{tools.length}</span>}</button>)}</div>
    {API_TOOL_SECTIONS.filter((item) => item.id !== section).map((item) => <section key={item.id} id={`api-tools-panel-${item.id}`} role="tabpanel" aria-labelledby={`api-tools-tab-${item.id}`} hidden/>)}
    {section === 'installed' && <section id="api-tools-panel-installed" role="tabpanel" aria-labelledby="api-tools-tab-installed" className="panel api-tool-panel"><div className="panel-header"><div><span className="eyebrow">Agent tools</span><h2>Installed APIs</h2><p>Test a connection or pause access without removing its saved configuration.</p></div></div>{tools.length ? <div className="api-tool-list">{tools.map((tool) => <article key={tool.id}><span className="tool-glyph">{tool.permissions.includes('jobs.read') ? <BriefcaseBusiness size={18}/> : tool.permissions.includes('web.search') ? <Search size={18}/> : tool.permissions.some((permission) => permission.startsWith('web.page.')) ? <FileSearch size={18}/> : <Wrench size={18}/>}</span><span><strong>{tool.name}</strong><small>{tool.kind.toUpperCase()} · {tool.description || 'No description'}</small></span><Status value={tool.enabled ? 'active' : 'paused'}/><button className="button" disabled={!tool.enabled || test.isPending} onClick={() => test.mutate(tool)}>{test.isPending ? <LoaderCircle className="spin" size={14}/> : 'Test'}</button><button className="button" disabled={toggle.isPending} onClick={() => toggle.mutate(tool)}>{tool.enabled ? 'Disable' : 'Enable'}</button></article>)}</div> : <EmptyState Icon={Unplug} title="No API tools" text="Add a read-only provider or custom HTTPS API for agents to use." action={<button className="button primary" onClick={() => setSection('providers')}>Browse providers</button>}/>}</section>}
    {section === 'add' && <section id="api-tools-panel-add" role="tabpanel" aria-labelledby="api-tools-tab-add" className="api-tool-stack"><DemoApiGallery/><section className="panel api-custom-entry"><span className="api-tool-glyph"><Code2 size={24}/></span><span className="eyebrow">Custom API</span><h2>Connect a secure HTTPS service</h2><p>Use a custom API for an internal system or a service that is not represented by a provider. Woody stores configuration server-side and can run a safe health check.</p><button className="button primary" onClick={openConnect}>Add custom API</button></section></section>}
    {section === 'providers' && <section id="api-tools-panel-providers" role="tabpanel" aria-labelledby="api-tools-tab-providers" className="api-tool-stack"><WebResearchPanel/><JobSearchPanel/></section>}
    {section === 'activity' && <section id="api-tools-panel-activity" role="tabpanel" aria-labelledby="api-tools-tab-activity" className="panel api-tool-activity"><Activity size={22}/><div><span className="eyebrow">Connection activity</span><h2>Keep API access intentional</h2><p>Use the Installed section to test health, pause a tool, or review its current access state. API configuration and provider credentials remain server-side.</p></div><button className="button" onClick={() => setSection('installed')}>Review installed APIs</button></section>}
  </div>;
}
