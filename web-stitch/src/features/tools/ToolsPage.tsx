import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, ArrowRightLeft, Blocks, BookOpen, BriefcaseBusiness, CheckCircle2, CloudSun, Code2, ExternalLink, FileSearch, Globe2, KeyRound, LoaderCircle, Plus, RefreshCw, Search, ServerCog, ShieldCheck, Unplug, Wrench } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, type Tool } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { EmptyState, PageHeader, Status } from '../../components/ui';
import { BrandIcon } from '../../components/BrandIcon';
import { handleTabListKeyDown } from '../../lib/a11y';
import './web-research.css';

type Section = 'connected' | 'web' | 'jobs' | 'apps' | 'custom';

export function ToolsPage({ openConnect }: { openConnect: () => void }) {
  const { data, report, reportError } = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const requestedSection = params.get('section');
  const section: Section = requestedSection === 'web' || requestedSection === 'jobs' || requestedSection === 'apps' || requestedSection === 'custom' ? requestedSection : 'connected';
  const setSection = (next: Section) => {
    setParams(next === 'connected' ? {} : { section: next });
  };
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
    <div className="integration-sections" role="tablist" aria-label="Integration sections" onKeyDown={handleTabListKeyDown}><button id="integrations-tab-connected" type="button" role="tab" aria-selected={section === 'connected'} aria-controls="integrations-panel-connected" tabIndex={section === 'connected' ? 0 : -1} className={section === 'connected' ? 'active' : ''} onClick={() => setSection('connected')}><CheckCircle2 size={15}/>Connected <span>{data.tools.length + mcp.length}</span></button><button id="integrations-tab-web" type="button" role="tab" aria-selected={section === 'web'} aria-controls="integrations-panel-web" tabIndex={section === 'web' ? 0 : -1} className={section === 'web' ? 'active' : ''} onClick={() => setSection('web')}><Search size={15}/>Web research</button><button id="integrations-tab-jobs" type="button" role="tab" aria-selected={section === 'jobs'} aria-controls="integrations-panel-jobs" tabIndex={section === 'jobs' ? 0 : -1} className={section === 'jobs' ? 'active' : ''} onClick={() => setSection('jobs')}><BriefcaseBusiness size={15}/>Job search</button><button id="integrations-tab-apps" type="button" role="tab" aria-selected={section === 'apps'} aria-controls="integrations-panel-apps" tabIndex={section === 'apps' ? 0 : -1} className={section === 'apps' ? 'active' : ''} onClick={() => setSection('apps')}><Globe2 size={15}/>App catalog</button><button id="integrations-tab-custom" type="button" role="tab" aria-selected={section === 'custom'} aria-controls="integrations-panel-custom" tabIndex={section === 'custom' ? 0 : -1} className={section === 'custom' ? 'active' : ''} onClick={() => setSection('custom')}><Code2 size={15}/>Custom API</button></div>
    {section === 'connected' && <section id="integrations-panel-connected" role="tabpanel" aria-labelledby="integrations-tab-connected" className="integration-connected-grid">
      <article className="panel integration-connection-panel"><div className="panel-header"><div><span className="eyebrow">Agent tools</span><h2>APIs and web research</h2></div><button className="text-button" onClick={() => setSection('web')}>Add research tool</button></div>{data.tools.length ? <div className="integration-connection-list">{data.tools.map((tool) => <article key={tool.id}><span className="tool-glyph">{tool.permissions.includes('jobs.read') ? <BriefcaseBusiness size={18}/> : tool.permissions.includes('web.search') ? <Search size={18}/> : tool.permissions.some((permission) => permission.startsWith('web.page.')) ? <FileSearch size={18}/> : <Wrench size={18}/>}</span><span><strong>{tool.name}</strong><small>{tool.kind.toUpperCase()} · {tool.description || 'No description'}</small></span><Status value={tool.enabled ? 'active' : 'paused'}/><button className="button" disabled={!tool.enabled || test.isPending} onClick={() => test.mutate(tool)}>Test</button><button className="button" disabled={toggle.isPending} onClick={() => toggle.mutate(tool)}>{tool.enabled ? 'Disable' : 'Enable'}</button></article>)}</div> : <EmptyState Icon={Unplug} title="No agent tools" text="Add a web research provider, safe page reader, or custom HTTPS API." action={<button className="button primary" onClick={() => setSection('web')}>Add web research</button>}/>}</article>
      <article className="panel integration-connection-panel"><div className="panel-header"><div><span className="eyebrow">Application connections</span><h2>MCP apps</h2></div><button className="text-button" onClick={() => navigate('/mcp')}>Manage apps</button></div>{connections.isLoading ? <EmptyState Icon={LoaderCircle} title="Loading applications" text="Checking connection health and installed tools."/> : mcp.length ? <div className="integration-connection-list">{mcp.slice(0, 8).map((connection) => <article key={connection.id}><span className="tool-glyph"><ServerCog size={18}/></span><span><strong>{connection.name}</strong><small>{connection.tool_count ?? 0} actions · {connection.agent_count ?? 0} assigned agents</small></span><Status value={connection.enabled ? connection.health_status : 'paused'}/><button className="button" onClick={() => navigate(`/mcp?connection=${connection.id}`)}>Review</button></article>)}</div> : <EmptyState Icon={Blocks} title="No apps connected" text="Browse official application connections or safely review Community Registry servers." action={<button className="button primary" onClick={() => navigate('/mcp')}>Browse app catalog</button>}/>}</article>
    </section>}
    {section === 'web' && <WebResearchPanel/>}
    {section === 'jobs' && <JobSearchPanel/>}
    {section === 'apps' && <section id="integrations-panel-apps" role="tabpanel" aria-labelledby="integrations-tab-apps" className="integration-app-entry panel"><div><span className="integration-app-glyph"><Globe2 size={24}/></span><span className="eyebrow">Application catalog</span><h2>Connect familiar apps, not protocol jargon</h2><p>Browse supported applications such as Notion, Gmail, Google Drive, GitHub, Slack and more. Woody shows their real actions, authentication state, health, assigned agents and least-privilege access.</p><div className="integration-app-points"><span><KeyRound size={14}/>Encrypted authentication</span><span><ShieldCheck size={14}/>Explicit per-agent access</span><span><Activity size={14}/>Health and call activity</span></div><button className="button primary" onClick={() => navigate('/mcp')}>Browse app catalog</button></div><aside><strong>Advanced MCP remains available</strong><p>Use it for Community Registry discovery, a custom Streamable HTTP endpoint, transport details and raw discovered-tool review.</p><button className="text-button" onClick={() => navigate('/mcp')}>Open Advanced MCP <Blocks size={14}/></button></aside></section>}
    {section === 'custom' && <div id="integrations-panel-custom" role="tabpanel" aria-labelledby="integrations-tab-custom" className="custom-api-panel"><DemoApiGallery/><section className="integration-app-entry panel custom-api-entry"><div><span className="integration-app-glyph"><Code2 size={24}/></span><span className="eyebrow">Custom API</span><h2>Connect a secure HTTPS service</h2><p>Use a custom API when it is an internal system or not represented by an application connection. Woody stores configuration server-side and can run a safe health check.</p><div className="integration-app-points"><span><ShieldCheck size={14}/>HTTPS only</span><span><KeyRound size={14}/>Secrets never return to browser</span><span><RefreshCw size={14}/>Safe health check</span></div><button className="button primary" onClick={openConnect}>Add custom API</button></div><aside><strong>Need an application connection?</strong><p>Prefer an app connection when available. It can expose named actions, OAuth, tool discovery, approvals and agent-specific allowlists.</p><button className="text-button" onClick={() => setSection('apps')}>Browse app catalog <Globe2 size={14}/></button></aside></section></div>}
  </div>;
}

function AgentToolAssignment({ tool, done }: { tool: Tool; done: () => void }) {
  const { data, report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const assign = useMutation({
    mutationFn: (agentId: string) => {
      const agent = data.agents.find((item) => item.id === agentId);
      if (!agent) throw new Error('Agent is no longer available');
      return api.updateAgent(agent.id, {
        capabilities: { ...agent.capabilities, webBrowser: true },
        toolIds: [...new Set([...agent.tool_ids, tool.id])],
      });
    },
    onSuccess: async (agent) => {
      report(`${tool.name} assigned to ${agent.name}`);
      await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not assign this tool'),
  });
  return <section className="panel web-assignment-panel"><div><span className="eyebrow">Next step</span><h2>Choose which agents may use {tool.name}</h2><p>Assignment also enables the agent’s Web access capability. Draft agents still need to be published before they can run.</p></div><div>{data.agents.filter((agent) => agent.status !== 'archived').map((agent) => {
    const assigned = agent.tool_ids.includes(tool.id) && agent.capabilities.webBrowser;
    return <article key={agent.id}><span><strong>{agent.name}</strong><small>{agent.role} · {agent.status}</small></span>{assigned ? <span className="status-badge ready"><i/>Assigned</span> : <button className="button" disabled={assign.isPending} onClick={() => assign.mutate(agent.id)}>{assign.isPending ? <LoaderCircle className="spin" size={14}/> : <Plus size={14}/>}Assign</button>}</article>;
  })}</div><button className="text-button" onClick={done}>Done assigning</button></section>;
}

function WebResearchPanel() {
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
    const form = new FormData(event.currentTarget);
    const provider = String(form.get('provider'));
    const domains = (name: string) => String(form.get(name) ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
    const body: Record<string, unknown> = { provider };
    if (provider === 'tavily' || provider === 'brave') Object.assign(body, { apiKey: String(form.get('apiKey')), safeSearch: String(form.get('safeSearch')), maxResults: Number(form.get('maxResults')), allowedDomains: domains('allowedDomains'), blockedDomains: domains('blockedDomains') });
    if (provider === 'firecrawl-search') Object.assign(body, { apiKey: String(form.get('apiKey')), maxResults: Number(form.get('maxResults')), allowedDomains: domains('allowedDomains'), blockedDomains: domains('blockedDomains') });
    if (provider === 'firecrawl-extract') Object.assign(body, { apiKey: String(form.get('apiKey')), maxCharacters: Number(form.get('maxCharacters')), allowedDomains: domains('allowedDomains'), blockedDomains: domains('blockedDomains') });
    if (provider === 'searxng') Object.assign(body, { endpoint: String(form.get('endpoint')), safeSearch: String(form.get('safeSearch')), maxResults: Number(form.get('maxResults')), allowedDomains: domains('allowedDomains'), blockedDomains: domains('blockedDomains') });
    if (provider === 'page-reader') Object.assign(body, { maxCharacters: Number(form.get('maxCharacters')), allowedDomains: domains('allowedDomains'), blockedDomains: domains('blockedDomains') });
    if (provider === 'reddit') Object.assign(body, { clientId: String(form.get('clientId')), clientSecret: String(form.get('clientSecret')), userAgent: String(form.get('userAgent')), maxResults: Number(form.get('maxResults')) });
    install.mutate(body);
  };
  return <section id="integrations-panel-web" role="tabpanel" aria-labelledby="integrations-tab-web" className="web-research-panel">
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

function JobSearchPanel() {
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
  return <section id="integrations-panel-jobs" role="tabpanel" aria-labelledby="integrations-tab-jobs" className="web-research-panel">
    <section className="panel web-research-intro"><BriefcaseBusiness size={22}/><div><span className="eyebrow">Job research</span><h2>Search roles without giving an agent application authority</h2><p>Job results are normalized into title, company, location, salary, date and source URL. This first release is read-only and cannot submit applications or contact employers.</p></div></section>
    {catalog.isLoading ? <EmptyState Icon={LoaderCircle} title="Loading job providers" text="Checking the server-owned job adapter catalog."/> : provider && <article className="panel job-provider-card"><span className="web-provider-icon"><BriefcaseBusiness size={21}/></span><div><small>{provider.category}</small><h2>{provider.title}</h2><p>{provider.description}</p><span>{provider.credential}</span></div><aside><a className="text-button" href={provider.documentationUrl} target="_blank" rel="noreferrer">API documentation <ExternalLink size={12}/></a><a className="text-button" href={provider.termsUrl} target="_blank" rel="noreferrer">Provider terms <ExternalLink size={12}/></a><button className={provider.installed ? 'button' : 'button primary'} onClick={() => setConfiguring(true)}>{provider.installed ? <RefreshCw size={14}/> : <Plus size={14}/>} {provider.installed ? 'Reconfigure' : 'Configure'}</button></aside></article>}
    {recentlyInstalled && <AgentToolAssignment tool={recentlyInstalled} done={() => setRecentlyInstalled(null)}/>}
    {configuring && <form className="panel web-provider-form" onSubmit={submit}><div className="panel-header"><div><span className="eyebrow">Secure connection</span><h2>Configure Adzuna Job Search</h2><p>Credentials are encrypted server-side. Default API limits and source attribution remain the responsibility of the account owner.</p></div><button type="button" className="text-button" onClick={() => setConfiguring(false)}>Cancel</button></div><div className="form-columns"><label>Adzuna app ID<input name="appId" required minLength={2} autoComplete="off"/></label><label>Adzuna app key<input type="password" name="appKey" required minLength={8} autoComplete="new-password"/></label></div><div className="form-columns"><label>Country code <small>Two letters supported by your Adzuna account</small><input name="country" required minLength={2} maxLength={2} pattern="[A-Za-z]{2}" placeholder="sg"/></label><label>Maximum results per search<input type="number" name="maxResults" min="1" max="10" defaultValue="5"/></label></div><div className="inline-safety-note"><ShieldCheck size={15}/><span><strong>Read-only by design</strong><small>Woody can search and summarize listings. Applying, messaging, uploading a CV, or opening an authenticated job account is not available through this tool.</small></span></div><label className="job-terms-check"><input type="checkbox" required/><span>I have reviewed Adzuna’s API terms and will preserve attribution and source links.</span></label><div className="form-actions"><button type="button" className="button" onClick={() => setConfiguring(false)}>Cancel</button><button className="button primary" disabled={install.isPending}>{install.isPending ? <LoaderCircle className="spin" size={15}/> : <ShieldCheck size={15}/>}Install read-only job search</button></div></form>}
  </section>;
}

function DemoApiGallery() {
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
