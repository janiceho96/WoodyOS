import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BookOpen, Command, GitBranch, HardDriveUpload, LoaderCircle, Plus, ShieldCheck, Wrench } from 'lucide-react';
import { type FormEvent } from 'react';
import { api, type Tool } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { EmptyState, PageHeader, Status } from '../../components/ui';

export function ToolsPage({ openConnect }: { openConnect: () => void }) {
  const { data, report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
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
  const catalog = [
    { name: 'Slack', category: 'Collaboration', Icon: Command, explanation: 'OAuth connector is not configured in this backend.' },
    { name: 'GitHub', category: 'Development', Icon: GitBranch, explanation: 'OAuth connector is not configured in this backend.' },
    { name: 'Google Drive', category: 'Storage', Icon: HardDriveUpload, explanation: 'OAuth connector is not configured in this backend.' },
    { name: 'Notion', category: 'Knowledge', Icon: BookOpen, explanation: 'OAuth connector is not configured in this backend.' },
  ];
  return <div className="tools-page">
    <PageHeader eyebrow="Integrations" title="Tools Marketplace" description="Connect real API or MCP tools without exposing credentials in the browser." actions={<button className="button primary" onClick={openConnect}><Plus size={15}/>Connect API tool</button>}/>
    <section className="market-grid">{catalog.map(({ name, category, Icon, explanation }) => <article className="market-card panel" key={name}><div><span><Icon size={21}/></span><Status value="idle"/></div><h2>{name}</h2><p>{category} integration template.</p><button className="button" disabled title={explanation}>Connect</button><small>{explanation}</small></article>)}</section>
    <section className="panel connected-tools"><div className="panel-header"><div><span className="eyebrow">Workspace runtime</span><h2>Connected tools</h2></div></div>{data.tools.length ? <div>{data.tools.map((tool) => <article key={tool.id}><span className="tool-glyph"><Wrench size={18}/></span><span><strong>{tool.name}</strong><small>{tool.kind.toUpperCase()} · {tool.description || 'No description'}</small></span><Status value={tool.enabled ? 'active' : 'paused'}/><button className="button" disabled={!tool.enabled || test.isPending} onClick={() => test.mutate(tool)}>Test connection</button><button className="button" disabled={toggle.isPending} onClick={() => toggle.mutate(tool)}>{tool.enabled ? 'Disable' : 'Enable'}</button></article>)}</div> : <EmptyState Icon={Wrench} title="No tools connected" text="Connect a public HTTPS API or MCP endpoint for your agents." action={<button className="button primary" onClick={openConnect}>Connect API tool</button>}/>}</section>
  </div>;
}

export function ToolDialogBody({ close }: { close: () => void }) {
  const { report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: api.createTool,
    onSuccess: async () => { report('API tool connected'); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); close(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not connect tool'),
  });
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    mutation.mutate({ name: String(form.get('name')), kind: 'api', description: String(form.get('description')), config: { endpoint: String(form.get('endpoint')), healthCheckUrl: String(form.get('healthCheckUrl')), method: String(form.get('method')) }, permissions: String(form.get('permissions')).split(',').map((item) => item.trim()).filter(Boolean) });
  };
  return <form className="form-grid" onSubmit={send}><div className="security-note"><ShieldCheck size={17}/><span>Configuration is encrypted by the backend. Secret values are never returned to this frontend.</span></div><label>Name<input name="name" required minLength={2} placeholder="Company Search API"/></label><label>Description<input name="description" placeholder="What can agents do with this tool?"/></label><div className="form-columns"><label>HTTPS endpoint<input name="endpoint" type="url" required pattern="https://.*" placeholder="https://api.example.com/search"/></label><label>Method<select name="method"><option>GET</option><option>POST</option></select></label></div><label>Health-check URL <small>Safe GET endpoint used by Test connection</small><input name="healthCheckUrl" type="url" required pattern="https://.*" placeholder="https://api.example.com/health"/></label><label>Permissions <small>Comma separated</small><input name="permissions" placeholder="knowledge.read, reports.create"/></label>{mutation.error && <div className="inline-error"><AlertTriangle size={15}/>{mutation.error.message}</div>}<div className="form-actions"><button className="button" type="button" onClick={close}>Cancel</button><button className="button primary" disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="spin" size={15}/> : <Wrench size={15}/>}Connect tool</button></div></form>;
}
