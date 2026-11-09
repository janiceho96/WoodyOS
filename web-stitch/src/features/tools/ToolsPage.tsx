import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRightLeft, BookOpen, BriefcaseBusiness, CloudSun, ExternalLink, FileSearch, Globe2, LoaderCircle, Plus, RefreshCw, Search, ShieldCheck, Wrench } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Tool } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { EmptyState } from '../../components/ui';
import { BrandIcon } from '../../components/BrandIcon';
import { normalizeAgentApiToolIds } from './agentToolAccess';

function AgentToolAssignment({ tool, done }: { tool: Tool; done: () => void }) {
  const { data, report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const assign = useMutation({
    mutationFn: async (agentId: string) => {
      const agent = data.agents.find((item) => item.id === agentId);
      if (!agent) throw new Error('Agent is no longer available');
      const assignment = normalizeAgentApiToolIds([...agent.tool_ids, tool.id], data.tools, [tool]);
      const saved = await api.updateAgent(agent.id, {
        capabilities: { ...agent.capabilities, webBrowser: true },
        toolIds: assignment.toolIds,
      });
      return { saved, removedCount: assignment.removedCount };
    },
    onSuccess: async ({ saved, removedCount }) => {
      const cleanup = removedCount
        ? ` Removed ${removedCount} unavailable tool assignment${removedCount === 1 ? '' : 's'}.`
        : '';
      report(`${tool.name} assigned to ${saved.name}.${cleanup}`);
      await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not assign this tool'),
  });
  return <section className="panel web-assignment-panel"><div><span className="eyebrow">Next step</span><h2>Choose which agents may use {tool.name}</h2><p>Assignment also enables the agent’s Web access capability. Draft agents still need to be published before they can run.</p></div><div>{data.agents.filter((agent) => agent.status !== 'archived').map((agent) => {
    const assigned = agent.tool_ids.includes(tool.id) && agent.capabilities.webBrowser;
    return <article key={agent.id}><span><strong>{agent.name}</strong><small>{agent.role} · {agent.status}</small></span>{assigned ? <span className="status-badge ready"><i/>Assigned</span> : <button className="button" disabled={assign.isPending} onClick={() => assign.mutate(agent.id)}>{assign.isPending ? <LoaderCircle className="spin" size={14}/> : <Plus size={14}/>}Assign</button>}</article>;
  })}</div><button className="text-button" onClick={done}>Done assigning</button></section>;
}

function webResearchPayload(form: FormData): Record<string, unknown> {
  const provider = String(form.get('provider'));
  const domains = (name: string) => String(form.get(name) ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const body: Record<string, unknown> = { provider };
  if (provider === 'tavily' || provider === 'brave') Object.assign(body, { apiKey: String(form.get('apiKey')), safeSearch: String(form.get('safeSearch')), maxResults: Number(form.get('maxResults')), allowedDomains: domains('allowedDomains'), blockedDomains: domains('blockedDomains') });
  if (provider === 'firecrawl-search') Object.assign(body, { apiKey: String(form.get('apiKey')), maxResults: Number(form.get('maxResults')), allowedDomains: domains('allowedDomains'), blockedDomains: domains('blockedDomains') });
  if (provider === 'firecrawl-extract') Object.assign(body, { apiKey: String(form.get('apiKey')), maxCharacters: Number(form.get('maxCharacters')), allowedDomains: domains('allowedDomains'), blockedDomains: domains('blockedDomains') });
  if (provider === 'searxng') Object.assign(body, { endpoint: String(form.get('endpoint')), safeSearch: String(form.get('safeSearch')), maxResults: Number(form.get('maxResults')), allowedDomains: domains('allowedDomains'), blockedDomains: domains('blockedDomains') });
  if (provider === 'page-reader') Object.assign(body, { maxCharacters: Number(form.get('maxCharacters')), allowedDomains: domains('allowedDomains'), blockedDomains: domains('blockedDomains') });
  if (provider === 'reddit') Object.assign(body, { clientId: String(form.get('clientId')), clientSecret: String(form.get('clientSecret')), userAgent: String(form.get('userAgent')), maxResults: Number(form.get('maxResults')) });
  return body;
}

export function WebResearchPanel() {
  const { report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const catalog = useQuery({ queryKey: ['web-research-catalog'], queryFn: api.webResearchCatalog });
  const [selected, setSelected] = useState<string | null>(null);
  const [recentlyInstalled, setRecentlyInstalled] = useState<Tool | null>(null);
  const install = useMutation({
    mutationFn: api.installWebResearchTool,
    onSuccess: async (tool) => {
      report(`${tool.name} saved. Assign it to an agent with Web access enabled.`);
      setRecentlyInstalled(tool);
      setSelected(null);
      await queryClient.invalidateQueries({ queryKey: ['web-research-catalog'] });
      await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not install web research tool'),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    install.mutate(webResearchPayload(new FormData(event.currentTarget)));
  };
  return <section className="web-research-panel">
    <section className="panel web-research-intro"><Globe2 size={22}/><div><span className="eyebrow">Web research</span><h2>Give selected agents safe internet eyes</h2><p>Search, page reading, and site adapters remain separate tools. Credentials stay encrypted, every tool is read-only, and nothing is assigned to an agent automatically.</p></div></section>
    {catalog.isLoading ? <EmptyState Icon={LoaderCircle} title="Loading web research providers" text="Checking server-owned provider definitions."/> : <div className="web-provider-grid">{catalog.data?.data.map((item) => <article className={`panel web-provider-card${item.recommended ? ' recommended' : ''}`} key={item.id}><span className="web-provider-icon">{item.id === 'page-reader' || item.id === 'firecrawl-extract' ? <FileSearch size={21}/> : item.id === 'reddit' ? <BrandIcon iconKey="reddit" size={21}/> : <Search size={21}/>}</span><span><small>{item.category}{item.recommended ? ' · Recommended' : ''}</small><h2>{item.title}</h2><p>{item.description}</p></span><div><span>{item.credential ?? 'No credentials required'}</span><button className={item.installed ? 'button' : 'button primary'} onClick={() => setSelected(item.id)}>{item.installed ? <RefreshCw size={14}/> : <Plus size={14}/>} {item.installed ? 'Reconfigure' : 'Configure'}</button></div></article>)}</div>}
    {recentlyInstalled && <AgentToolAssignment tool={recentlyInstalled} done={() => setRecentlyInstalled(null)}/>}
    {selected && <form className="panel web-provider-form" onSubmit={submit}><input type="hidden" name="provider" value={selected}/><div className="panel-header"><div><span className="eyebrow">Secure connection</span><h2>Configure {catalog.data?.data.find((item) => item.id === selected)?.title}</h2><p>Secrets are encrypted by Woody’s backend and never returned to this browser or an agent.</p></div><button type="button" className="text-button" onClick={() => setSelected(null)}>Cancel</button></div>
      {(selected === 'tavily' || selected === 'brave' || selected === 'firecrawl-search' || selected === 'firecrawl-extract') && <label>API key<input type="password" name="apiKey" required minLength={8} autoComplete="new-password" placeholder="Paste provider API key"/></label>}
      {(selected === 'firecrawl-search' || selected === 'firecrawl-extract') && <div className="inline-safety-note"><ShieldCheck size={15}/><span><strong>Read-only and credit bounded</strong><small>Woody exposes no Firecrawl browser actions. Search is capped at 10 results and extraction at 50,000 characters.</small></span></div>}
      {selected === 'searxng' && <label>SearXNG JSON search endpoint<input type="url" name="endpoint" required pattern="https://.*" placeholder="https://search.example.com/search"/></label>}
      {selected === 'reddit' && <><div className="inline-warning"><AlertTriangle size={16}/>Use only Reddit credentials approved for your intended use and follow Reddit’s API terms.</div><div className="form-columns"><label>Client ID<input name="clientId" required minLength={4}/></label><label>Client secret<input type="password" name="clientSecret" required minLength={8} autoComplete="new-password"/></label></div><label>Descriptive user agent<input name="userAgent" required minLength={8} placeholder="macos:woody-agent-os:v0.1 (by /u/yourname)"/></label></>}
      {(selected === 'page-reader' || selected === 'firecrawl-extract') && <label>Maximum characters per page<input type="number" name="maxCharacters" min="1000" max="50000" defaultValue="20000"/></label>}
      {selected !== 'page-reader' && selected !== 'firecrawl-extract' && <label>Maximum results per search<input type="number" name="maxResults" min="1" max="10" defaultValue="5"/></label>}
      {selected !== 'reddit' && <><div className="form-columns"><label>Allowed domains <small>Optional, comma-separated</small><input name="allowedDomains" placeholder="reddit.com, zhihu.com"/></label><label>Blocked domains <small>Optional, comma-separated</small><input name="blockedDomains" placeholder="example.com"/></label></div>{selected === 'tavily' ? <><input type="hidden" name="safeSearch" value="strict"/><div className="inline-safety-note"><ShieldCheck size={15}/><span><strong>Safe Search is always enabled</strong><small>Tavily exposes one on/off safety control, so Woody keeps it on for every agent search.</small></span></div></> : (selected === 'brave' || selected === 'searxng') && <label>Safe Search<select name="safeSearch" defaultValue="moderate"><option value="moderate">Moderate</option><option value="strict">Strict</option></select></label>}</>}
      <div className="form-actions"><button type="button" className="button" onClick={() => setSelected(null)}>Cancel</button><button className="button primary" disabled={install.isPending}>{install.isPending ? <LoaderCircle className="spin" size={15}/> : <ShieldCheck size={15}/>}Install read-only tool</button></div>
    </form>}
  </section>;
}

export function JobSearchPanel() {
  const { report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const catalog = useQuery({ queryKey: ['job-tool-catalog'], queryFn: api.jobToolCatalog });
  const [configuring, setConfiguring] = useState(false);
  const [recentlyInstalled, setRecentlyInstalled] = useState<Tool | null>(null);
  const install = useMutation({
    mutationFn: api.installJobTool,
    onSuccess: async (tool) => {
      report(`${tool.name} saved. Assign it only to the agents that need job research.`);
      setRecentlyInstalled(tool);
      setConfiguring(false);
      await queryClient.invalidateQueries({ queryKey: ['job-tool-catalog'] });
      await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not install job search'),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    install.mutate({
      provider: 'adzuna',
      appId: String(form.get('appId')),
      appKey: String(form.get('appKey')),
      country: String(form.get('country')).trim().toLowerCase(),
      maxResults: Number(form.get('maxResults')),
    });
  };
  const provider = catalog.data?.data[0];
  return <section className="web-research-panel">
    <section className="panel web-research-intro"><BriefcaseBusiness size={22}/><div><span className="eyebrow">Job research</span><h2>Search roles without giving an agent application authority</h2><p>Job results are normalized into title, company, location, salary, date and source URL. This first release is read-only and cannot submit applications or contact employers.</p></div></section>
    {catalog.isLoading ? <EmptyState Icon={LoaderCircle} title="Loading job providers" text="Checking the server-owned job adapter catalog."/> : provider && <article className="panel job-provider-card"><span className="web-provider-icon"><BriefcaseBusiness size={21}/></span><div><small>{provider.category}</small><h2>{provider.title}</h2><p>{provider.description}</p><span>{provider.credential}</span></div><aside><a className="text-button" href={provider.documentationUrl} target="_blank" rel="noreferrer">API documentation <ExternalLink size={12}/></a><a className="text-button" href={provider.termsUrl} target="_blank" rel="noreferrer">Provider terms <ExternalLink size={12}/></a><button className={provider.installed ? 'button' : 'button primary'} onClick={() => setConfiguring(true)}>{provider.installed ? <RefreshCw size={14}/> : <Plus size={14}/>} {provider.installed ? 'Reconfigure' : 'Configure'}</button></aside></article>}
    {recentlyInstalled && <AgentToolAssignment tool={recentlyInstalled} done={() => setRecentlyInstalled(null)}/>}
    {configuring && <form className="panel web-provider-form" onSubmit={submit}><div className="panel-header"><div><span className="eyebrow">Secure connection</span><h2>Configure Adzuna Job Search</h2><p>Credentials are encrypted server-side. Default API limits and source attribution remain the responsibility of the account owner.</p></div><button type="button" className="text-button" onClick={() => setConfiguring(false)}>Cancel</button></div><div className="form-columns"><label>Adzuna app ID<input name="appId" required minLength={2} autoComplete="off"/></label><label>Adzuna app key<input type="password" name="appKey" required minLength={8} autoComplete="new-password"/></label></div><div className="form-columns"><label>Country code <small>Two letters supported by your Adzuna account</small><input name="country" required minLength={2} maxLength={2} pattern="[A-Za-z]{2}" placeholder="sg"/></label><label>Maximum results per search<input type="number" name="maxResults" min="1" max="10" defaultValue="5"/></label></div><div className="inline-safety-note"><ShieldCheck size={15}/><span><strong>Read-only by design</strong><small>Woody can search and summarize listings. Applying, messaging, uploading a CV, or opening an authenticated job account is not available through this tool.</small></span></div><label className="job-terms-check"><input type="checkbox" required/><span>I have reviewed Adzuna’s API terms and will preserve attribution and source links.</span></label><div className="form-actions"><button type="button" className="button" onClick={() => setConfiguring(false)}>Cancel</button><button className="button primary" disabled={install.isPending}>{install.isPending ? <LoaderCircle className="spin" size={15}/> : <ShieldCheck size={15}/>}Install read-only job search</button></div></form>}
  </section>;
}

export function DemoApiGallery() {
  const { report, reportError } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const demos = useQuery({ queryKey: ['demo-apis'], queryFn: api.demoApis });
  const install = useMutation({
    mutationFn: api.installDemoApi,
    onSuccess: async (tool) => {
      report(tool.alreadyInstalled ? `${tool.name} is already installed` : `${tool.name} installed as a read-only API`);
      await queryClient.invalidateQueries({ queryKey: ['demo-apis'] });
      await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not install demo API'),
  });
  return <section className="panel demo-api-panel"><div className="panel-header"><div><span className="eyebrow">Safe practice tools</span><h2>Try a real read-only API</h2><p>These public GET APIs need no key, cannot write external data, and are installed from server-owned definitions.</p></div><ShieldCheck size={20}/></div>{demos.isLoading ? <EmptyState Icon={LoaderCircle} title="Loading demo APIs" text="Reading the backend-owned starter catalog."/> : <div className="demo-api-grid">{demos.data?.data.map((demo) => <article key={demo.slug}><span className="demo-api-icon">{demo.slug === 'weather-forecast' ? <CloudSun size={19}/> : demo.slug === 'book-search' ? <BookOpen size={19}/> : <ArrowRightLeft size={19}/>}</span><span><small>{demo.provider}</small><strong>{demo.name.replace('Demo · ', '')}</strong><p>{demo.description}</p></span><code>{demo.examplePrompt}</code><div><a className="text-button" href={demo.documentationUrl} target="_blank" rel="noreferrer">Docs <ExternalLink size={12}/></a>{demo.installed ? <button className="button" onClick={() => navigate('/agents')}>Assign to agent</button> : <button className="button primary" disabled={install.isPending} onClick={() => install.mutate(demo.slug)}>{install.isPending ? <LoaderCircle className="spin" size={13}/> : <Plus size={13}/>}Install</button>}</div></article>)}</div>}</section>;
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
