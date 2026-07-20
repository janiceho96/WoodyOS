import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, Blocks, CheckCircle2, Code2, Globe2, KeyRound, LoaderCircle, Plus, RefreshCw, ServerCog, ShieldCheck, Unplug, Wrench } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Tool } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { EmptyState, PageHeader, Status } from '../../components/ui';

type Section = 'connected' | 'apps' | 'custom';

export function ToolsPage({ openConnect }: { openConnect: () => void }) {
  const { data, report, reportError } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [section, setSection] = useState<Section>('connected');
  const connections = useQuery({ queryKey: ['mcp-connections'], queryFn: api.mcpConnections, refetchInterval: 15_000 });
  const test = useMutation({
    mutationFn: (tool: Tool) => api.testTool(tool.id).then(() => tool),
    onSuccess: (tool) => report(`${tool.name} connection is healthy`),
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Tool health test failed'),
  });
  const toggle = useMutation({
    mutationFn: (tool: Tool) => api.updateTool(tool.id, { enabled: !tool.enabled }).then(() => tool),
    onSuccess: async (tool) => { report(`${tool.name} ${tool.enabled ? 'disabled' : 'enabled'}`); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not update tool'),
  });
  const mcp = connections.data?.data ?? [];
  const activeConnections = mcp.filter((connection) => connection.enabled).length + data.tools.filter((tool) => tool.enabled).length;

  return <div className="tools-page integrations-page">
    <PageHeader eyebrow="Resources" title="Integrations" description="Connect the applications and APIs your agents may use, then control their access explicitly." actions={<><button className="button" onClick={() => navigate('/mcp')}><Blocks size={15}/>Advanced MCP</button><button className="button primary" onClick={openConnect}><Plus size={15}/>Custom API</button></>}/>
    <section className="integrations-safety"><ShieldCheck size={20}/><div><strong>Connections stay private and off by default</strong><p>Credentials are encrypted by Woody’s backend. Agents receive only the specific tools and permissions you allow.</p></div><span>{activeConnections} active connection{activeConnections === 1 ? '' : 's'}</span></section>
    <div className="integration-sections" role="tablist" aria-label="Integration sections"><button className={section === 'connected' ? 'active' : ''} onClick={() => setSection('connected')}><CheckCircle2 size={15}/>Connected <span>{data.tools.length + mcp.length}</span></button><button className={section === 'apps' ? 'active' : ''} onClick={() => setSection('apps')}><Globe2 size={15}/>App catalog</button><button className={section === 'custom' ? 'active' : ''} onClick={() => setSection('custom')}><Code2 size={15}/>Custom API</button></div>
    {section === 'connected' && <section className="integration-connected-grid">
      <article className="panel integration-connection-panel"><div className="panel-header"><div><span className="eyebrow">API connections</span><h2>Custom APIs</h2></div><button className="text-button" onClick={openConnect}>Add API</button></div>{data.tools.length ? <div className="integration-connection-list">{data.tools.map((tool) => <article key={tool.id}><span className="tool-glyph"><Wrench size={18}/></span><span><strong>{tool.name}</strong><small>{tool.kind.toUpperCase()} · {tool.description || 'No description'}</small></span><Status value={tool.enabled ? 'active' : 'paused'}/><button className="button" disabled={!tool.enabled || test.isPending} onClick={() => test.mutate(tool)}>Test</button><button className="button" disabled={toggle.isPending} onClick={() => toggle.mutate(tool)}>{tool.enabled ? 'Disable' : 'Enable'}</button></article>)}</div> : <EmptyState Icon={Unplug} title="No custom APIs" text="Add a secure HTTPS API for an internal service or a provider not available in the app catalog." action={<button className="button" onClick={openConnect}>Add custom API</button>}/>}</article>
      <article className="panel integration-connection-panel"><div className="panel-header"><div><span className="eyebrow">Application connections</span><h2>MCP apps</h2></div><button className="text-button" onClick={() => navigate('/mcp')}>Manage apps</button></div>{connections.isLoading ? <EmptyState Icon={LoaderCircle} title="Loading applications" text="Checking connection health and installed tools."/> : mcp.length ? <div className="integration-connection-list">{mcp.slice(0, 8).map((connection) => <article key={connection.id}><span className="tool-glyph"><ServerCog size={18}/></span><span><strong>{connection.name}</strong><small>{connection.tool_count ?? 0} actions · {connection.agent_count ?? 0} assigned agents</small></span><Status value={connection.enabled ? connection.health_status : 'paused'}/><button className="button" onClick={() => navigate(`/mcp?connection=${connection.id}`)}>Review</button></article>)}</div> : <EmptyState Icon={Blocks} title="No apps connected" text="Browse official application connections or safely review Community Registry servers." action={<button className="button primary" onClick={() => navigate('/mcp')}>Browse app catalog</button>}/>}</article>
    </section>}
    {section === 'apps' && <section className="integration-app-entry panel"><div><span className="integration-app-glyph"><Globe2 size={24}/></span><span className="eyebrow">Application catalog</span><h2>Connect familiar apps, not protocol jargon</h2><p>Browse supported applications such as Notion, Gmail, Google Drive, GitHub, Slack and more. Woody shows their real actions, authentication state, health, assigned agents and least-privilege access.</p><div className="integration-app-points"><span><KeyRound size={14}/>Encrypted authentication</span><span><ShieldCheck size={14}/>Explicit per-agent access</span><span><Activity size={14}/>Health and call activity</span></div><button className="button primary" onClick={() => navigate('/mcp')}>Browse app catalog</button></div><aside><strong>Advanced MCP remains available</strong><p>Use it for Community Registry discovery, a custom Streamable HTTP endpoint, transport details and raw discovered-tool review.</p><button className="text-button" onClick={() => navigate('/mcp')}>Open Advanced MCP <Blocks size={14}/></button></aside></section>}
    {section === 'custom' && <section className="integration-app-entry panel custom-api-entry"><div><span className="integration-app-glyph"><Code2 size={24}/></span><span className="eyebrow">Custom API</span><h2>Connect a secure HTTPS service</h2><p>Use a custom API when it is an internal system or not represented by an application connection. Woody stores configuration server-side and can run a safe health check.</p><div className="integration-app-points"><span><ShieldCheck size={14}/>HTTPS only</span><span><KeyRound size={14}/>Secrets never return to browser</span><span><RefreshCw size={14}/>Safe health check</span></div><button className="button primary" onClick={openConnect}>Add custom API</button></div><aside><strong>Need an application connection?</strong><p>Prefer an app connection when available. It can expose named actions, OAuth, tool discovery, approvals and agent-specific allowlists.</p><button className="text-button" onClick={() => setSection('apps')}>Browse app catalog <Globe2 size={14}/></button></aside></section>}
  </div>;
}

export function ToolDialogBody({ close }: { close: () => void }) {
  const { report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: api.createTool,
    onSuccess: async () => { report('Custom API connection saved. Test it before assigning it to an agent.'); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); close(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not connect API'),
  });
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    mutation.mutate({ name: String(form.get('name')), kind: 'api', description: String(form.get('description')), config: { endpoint: String(form.get('endpoint')), healthCheckUrl: String(form.get('healthCheckUrl')), method: String(form.get('method')) }, permissions: String(form.get('permissions')).split(',').map((item) => item.trim()).filter(Boolean) });
  };
  return <form className="form-grid" onSubmit={send}><div className="security-note"><ShieldCheck size={17}/><span>Configuration is encrypted by the backend. Secret values are never returned to this frontend. Add only an HTTPS endpoint you trust.</span></div><label>Name<input name="name" required minLength={2} placeholder="Company Search API"/></label><label>Description<input name="description" placeholder="What can agents do with this API?"/></label><div className="form-columns"><label>HTTPS endpoint<input name="endpoint" type="url" required pattern="https://.*" placeholder="https://api.example.com/search"/></label><label>Method<select name="method"><option>GET</option><option>POST</option></select></label></div><label>Health-check URL <small>Safe GET endpoint used by Test connection</small><input name="healthCheckUrl" type="url" required pattern="https://.*" placeholder="https://api.example.com/health"/></label><label>Permissions <small>Comma-separated labels used to describe intended access</small><input name="permissions" placeholder="knowledge.read, reports.create"/></label>{mutation.error && <div className="inline-error"><AlertTriangle size={15}/>{mutation.error.message}</div>}<div className="form-actions"><button className="button" type="button" onClick={close}>Cancel</button><button className="button primary" disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="spin" size={15}/> : <Wrench size={15}/>}Save custom API</button></div></form>;
}
