import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity, AlertTriangle, BadgeCheck, Blocks, Building2, CheckCircle2, ExternalLink,
  Globe2, KeyRound, LoaderCircle, LockKeyhole, Plus, RefreshCw, Search, ServerCog,
  ShieldCheck, Sparkles, Trash2, Unplug, Users, Wrench,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api, type CuratedMcpApp, type McpAgentAccess, type McpCatalogServer, type McpConnection,
  type McpTool, type McpToolCall, type Tool,
} from '../../api';
import { useWorkspace } from '../../app/workspace';
import { AppBrandMark } from '../../components/AppBrandMark';
import { AgentAvatar } from '../../components/agents/AgentAvatar';
import { EmptyState, Modal, PageHeader, Status } from '../../components/ui';
import { handleTabListKeyDown } from '../../lib/a11y';
import './mcp.css';

type InstallTarget =
  | { kind: 'curated'; app: CuratedMcpApp }
  | { kind: 'catalog'; server: McpCatalogServer }
  | { kind: 'custom' }
  | null;

// oxlint-disable-next-line react/only-export-components -- the workspace navigation contract is intentionally testable.
export const MCP_SECTIONS = [
  { id: 'discover', label: 'Discover' },
  { id: 'connected', label: 'Connected' },
  { id: 'access', label: 'Agent Access' },
  { id: 'activity', label: 'Activity' },
] as const;

type McpSection = (typeof MCP_SECTIONS)[number]['id'];

// oxlint-disable-next-line react/only-export-components -- the MCP access deep-link contract is intentionally testable.
export function mcpRouteState(params: URLSearchParams) {
  const tab = params.get('tab');
  const connectionId = params.get('connection');
  return {
    tab: MCP_SECTIONS.some((section) => section.id === tab) ? tab as McpSection : connectionId ? 'connected' : 'discover',
    connectionId,
  };
}

// oxlint-disable-next-line react/only-export-components -- the access-selection behavior is intentionally testable.
export function selectMcpConnection(connections: McpConnection[], selectedId: string | null) {
  return connections.find((connection) => connection.id === selectedId) ?? null;
}

// oxlint-disable-next-line react/only-export-components -- the legacy compatibility boundary is intentionally testable.
export function legacyMcpTools(tools: Tool[]) {
  return tools.filter((tool) => tool.kind === 'mcp');
}

export function McpMarketplacePage() {
  const { data, report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const routeState = mcpRouteState(params);
  const [tab, setTab] = useState<McpSection>(routeState.tab);
  const [catalogView, setCatalogView] = useState<'top' | 'community'>('top');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [installTarget, setInstallTarget] = useState<InstallTarget>(null);
  const [selectedId, setSelectedId] = useState<string | null>(routeState.connectionId);
  const featured = useQuery({ queryKey: ['mcp-featured'], queryFn: api.featuredMcpApps });
  const catalog = useQuery({
    queryKey: ['mcp-catalog', search],
    queryFn: () => api.mcpCatalog(search),
    enabled: catalogView === 'community',
  });
  const connections = useQuery({ queryKey: ['mcp-connections'], queryFn: api.mcpConnections, refetchInterval: 15_000 });
  const sync = useMutation({
    mutationFn: () => api.syncMcpCatalog(false),
    onSuccess: async (result) => {
      report(`MCP catalog synchronized: ${result.serversUpdated} records updated`);
      await queryClient.invalidateQueries({ queryKey: ['mcp-catalog'] });
    },
    onError: (cause) => reportError(message(cause, 'Could not synchronize the MCP catalog')),
  });
  const selected = selectMcpConnection(connections.data?.data ?? [], selectedId);
  const legacyTools = legacyMcpTools(data.tools);
  const filteredFeatured = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return featured.data?.data ?? [];
    return (featured.data?.data ?? []).filter((app) =>
      [app.title, app.publisher, app.category, app.description, ...app.capabilities]
        .some((value) => value.toLowerCase().includes(needle)));
  }, [featured.data, query]);
  useEffect(() => {
    setTab(routeState.tab);
    setSelectedId(routeState.connectionId);
  }, [routeState.connectionId, routeState.tab]);
  useEffect(() => {
    const url = new URL(window.location.href);
    const oauth = url.searchParams.get('oauth');
    const connectionId = url.searchParams.get('connection');
    if (!oauth) return;
    if (oauth === 'success') {
      report('MCP OAuth authorization completed. Test the connection to verify access.');
      setTab('connected');
      if (connectionId) setSelectedId(connectionId);
      void queryClient.invalidateQueries({ queryKey: ['mcp-connections'] });
    } else {
      reportError('MCP OAuth authorization failed or was cancelled');
    }
    url.searchParams.delete('oauth');
    url.searchParams.delete('connection');
    window.history.replaceState({}, '', url);
  }, [queryClient, report, reportError]);
  return <div className="mcp-page">
    <PageHeader eyebrow="Advanced integrations" title="MCP" description="Connect application servers, review their exact actions, and grant least-privilege agent access." actions={<>
      <button className="button" onClick={() => setInstallTarget({ kind: 'custom' })}><Plus size={15}/>Custom server</button>
      <button className="button primary" disabled={sync.isPending} onClick={() => sync.mutate()}>{sync.isPending ? <LoaderCircle className="spin" size={15}/> : <RefreshCw size={15}/>}Sync Registry</button>
    </>}/>
    <div className="mcp-security-banner"><ShieldCheck size={19}/><div><strong>Safe by default</strong><span>New connections and discovered tools remain disabled until tested and reviewed. Secrets never return to this browser.</span></div></div>
    <div className="tab-bar" role="tablist" aria-label="MCP connection sections" onKeyDown={handleTabListKeyDown}>{MCP_SECTIONS.map((section) => <button key={section.id} id={`mcp-tab-${section.id}`} type="button" role="tab" aria-selected={tab === section.id} aria-controls={`mcp-panel-${section.id}`} tabIndex={tab === section.id ? 0 : -1} className={tab === section.id ? 'active' : ''} onClick={() => setTab(section.id)}>{section.id === 'discover' ? <Blocks size={15}/> : section.id === 'connected' ? <ServerCog size={15}/> : section.id === 'access' ? <Users size={15}/> : <Activity size={15}/>}{section.label}{section.id === 'connected' && <span>{connections.data?.data.length ?? 0}</span>}</button>)}</div>
    {MCP_SECTIONS.filter((section) => section.id !== tab).map((section) => <section key={section.id} id={`mcp-panel-${section.id}`} role="tabpanel" aria-labelledby={`mcp-tab-${section.id}`} hidden/>)}
    {tab === 'discover' ? <section id="mcp-panel-discover" role="tabpanel" aria-labelledby="mcp-tab-discover">
      <div className="mcp-discovery-switch" role="tablist" aria-label="MCP discovery source" onKeyDown={handleTabListKeyDown}>
        <button id="mcp-source-tab-top" type="button" role="tab" aria-selected={catalogView === 'top'} aria-controls="mcp-source-panel-top" tabIndex={catalogView === 'top' ? 0 : -1} className={catalogView === 'top' ? 'active' : ''} onClick={() => { setCatalogView('top'); setQuery(''); }}><Sparkles size={15}/>Supported Apps</button>
        <button id="mcp-source-tab-community" type="button" role="tab" aria-selected={catalogView === 'community'} aria-controls="mcp-source-panel-community" tabIndex={catalogView === 'community' ? 0 : -1} className={catalogView === 'community' ? 'active' : ''} onClick={() => { setCatalogView('community'); setQuery(''); setSearch(''); }}><Globe2 size={15}/>Community MCP</button>
      </div>
      {catalogView === 'top' ? <section id="mcp-source-panel-top" role="tabpanel" aria-labelledby="mcp-source-tab-top">
        <div className="mcp-curated-intro"><div><BadgeCheck size={19}/><span><strong>Verified first-party endpoints</strong><small>Recognizable providers, official documentation, and clearly stated availability.</small></span></div><span className="official-count">{featured.data?.data.filter((app) => app.publisher !== 'Obsidian community').length ?? 0} official providers</span></div>
        <form className="mcp-search" onSubmit={(event) => event.preventDefault()}><Search size={17}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Notion, Google, GitHub, Stripe…"/></form>
        {featured.isLoading ? <Loading text="Loading curated apps…"/> : featured.error ? <InlineError error={featured.error}/> : filteredFeatured.length ? <>
          <div className="mcp-result-count">{filteredFeatured.length} trusted and recognizable integrations</div>
          <div className="mcp-catalog-grid mcp-featured-grid">{filteredFeatured.map((app) => <FeaturedCard key={app.id} app={app} open={() => setInstallTarget({ kind: 'curated', app })}/>)}</div>
        </> : <EmptyState Icon={Building2} title="No top apps found" text="Try another provider name or open the advanced Community Registry."/ >}
      </section> : <section id="mcp-source-panel-community" role="tabpanel" aria-labelledby="mcp-source-tab-community">
        <div className="mcp-community-warning"><AlertTriangle size={17}/><span><strong>Advanced community catalog</strong><small>Entries are publisher-submitted Registry metadata. Woody does not verify or endorse them. Review the domain, source, authentication, and requested tools before connecting.</small></span></div>
        <form className="mcp-search" onSubmit={(event) => { event.preventDefault(); setSearch(query.trim()); }}><Search size={17}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the full public MCP Registry…"/><button className="button" disabled={catalog.isFetching}>Search</button></form>
        {catalog.isLoading ? <Loading text="Loading cached Community Registry…"/> : catalog.error ? <InlineError error={catalog.error}/> : catalog.data?.data.length ? <>
          <div className="mcp-result-count">{catalog.data.total.toLocaleString()} compatible community servers</div>
          <div className="mcp-catalog-grid">{catalog.data.data.map((server) => <CatalogCard key={server.id} server={server} install={() => setInstallTarget({ kind: 'catalog', server })}/>)}</div>
        </> : <EmptyState Icon={Blocks} title="No compatible servers found" text="Try another search, synchronize the Registry, or add a custom Streamable HTTP endpoint."/ >}
      </section>}
    </section> : tab === 'connected' ? <section id="mcp-panel-connected" role="tabpanel" aria-labelledby="mcp-tab-connected">
      <div className="mcp-installed-layout">
        <ConnectionPicker
          connections={connections.data?.data ?? []}
          loading={connections.isLoading}
          selectedId={selectedId}
          select={setSelectedId}
          emptyAction={<button className="button primary" onClick={() => setTab('discover')}>Browse Registry</button>}
        />
        <div className="mcp-detail panel">{selected ? <ConnectionDetails connection={selected} configureAccess={() => setTab('access')}/> : <EmptyState Icon={ServerCog} title="Select a connection" text="Review its health, tools, and permissions."/ >}</div>
      </div>
      <LegacyMcpCompatibility tools={legacyTools}/>
    </section> : tab === 'access' ? <section id="mcp-panel-access" role="tabpanel" aria-labelledby="mcp-tab-access">
      <div className="mcp-installed-layout">
        <ConnectionPicker
          connections={connections.data?.data ?? []}
          loading={connections.isLoading}
          selectedId={selectedId}
          select={setSelectedId}
          heading="Select a connection"
          description="Choose the application server whose agent allowlists you want to review."
          emptyText="Connect an application server before granting agent access."
          emptyAction={<button className="button primary" onClick={() => setTab('discover')}>Discover MCP</button>}
        />
        <div className="mcp-detail panel">{selected ? <AgentAccessDetails connection={selected}/> : <EmptyState Icon={Users} title="Select a connection" text="Choose a connected application server before configuring its agent allowlists."/>}</div>
      </div>
    </section> : <section id="mcp-panel-activity" role="tabpanel" aria-labelledby="mcp-tab-activity"><McpActivity/></section>}
    {installTarget && <Modal title={installTarget.kind === 'custom' ? 'Add custom MCP server' : installTarget.kind === 'curated' ? `Connect ${installTarget.app.title}` : `Review ${installTarget.server.title}`} close={() => setInstallTarget(null)}><InstallDialog target={installTarget} cancel={() => setInstallTarget(null)} complete={(connectionId) => { setInstallTarget(null); setTab('connected'); setSelectedId(connectionId); }}/></Modal>}
  </div>;
}

function ConnectionPicker({
  connections, loading, selectedId, select, heading = 'Connections', description, emptyText = 'Install a Registry server or add a custom endpoint.', emptyAction,
}: {
  connections: McpConnection[];
  loading: boolean;
  selectedId: string | null;
  select: (id: string) => void;
  heading?: string;
  description?: string;
  emptyText?: string;
  emptyAction: ReactNode;
}) {
  return <div className="mcp-connection-list panel"><div className="panel-header"><div><span className="eyebrow">{heading === 'Connections' ? 'Workspace installations' : 'Least privilege'}</span><h2>{heading}</h2>{description && <p>{description}</p>}</div></div>
    {loading
      ? <Loading text="Loading connections…"/>
      : connections.length
        ? connections.map((connection) => <button key={connection.id} className={selectedId === connection.id ? 'selected' : ''} onClick={() => select(connection.id)}><AppBrandMark title={connection.name} size="small"/><span><strong>{connection.name}</strong><small>{connection.tool_count ?? 0} tools · {connection.agent_count ?? 0} agents</small></span><Status value={connectionState(connection)}/></button>)
        : <EmptyState Icon={Unplug} title="No MCP connections" text={emptyText} action={emptyAction}/>}
  </div>;
}

function LegacyMcpCompatibility({ tools }: { tools: Tool[] }) {
  const { report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const test = useMutation({
    mutationFn: (tool: Tool) => api.testTool(tool.id).then(() => tool),
    onSuccess: (tool) => report(`${tool.name} connection is healthy`),
    onError: (cause) => reportError(message(cause, 'Legacy MCP health test failed')),
  });
  const toggle = useMutation({
    mutationFn: (tool: Tool) => api.updateTool(tool.id, { enabled: !tool.enabled }).then(() => tool),
    onSuccess: async (tool) => {
      report(`${tool.name} ${tool.enabled ? 'disabled' : 'enabled'}`);
      await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (cause) => reportError(message(cause, 'Could not update legacy MCP tool')),
  });
  return <section className="panel api-tool-panel"><div className="panel-header"><div><span className="eyebrow">Compatibility</span><h2>Legacy MCP</h2><p>Older workspace tools remain manageable here. They are not represented as modern MCP connections or agent actions.</p></div></div>
    {tools.length ? <div className="api-tool-list">{tools.map((tool) => <article key={tool.id}><span className="tool-glyph"><ServerCog size={18}/></span><span><strong>{tool.name}</strong><small>LEGACY MCP · {tool.description || 'No description'}</small></span><Status value={tool.enabled ? 'active' : 'paused'}/><button className="button" disabled={!tool.enabled || test.isPending} onClick={() => test.mutate(tool)}>{test.isPending ? <LoaderCircle className="spin" size={14}/> : 'Test'}</button><button className="button" disabled={toggle.isPending} onClick={() => toggle.mutate(tool)}>{tool.enabled ? 'Disable' : 'Enable'}</button></article>)}</div> : <EmptyState Icon={Unplug} title="No legacy MCP tools" text="Workspace MCP tools created through the former integration path will appear here."/>}
  </section>;
}

function FeaturedCard({ app, open }: { app: CuratedMcpApp; open: () => void }) {
  const availability = app.availability === 'available' ? 'Ready to connect'
    : app.availability === 'preview' ? 'Developer Preview'
      : app.availability === 'limited' ? 'Limited access'
        : 'Desktop bridge required';
  return <article className={`mcp-catalog-card mcp-featured-card panel availability-${app.availability}`}>
    <div className="mcp-card-head"><AppBrandMark appId={app.id} title={app.title} color={app.brandColor}/><span className={`availability-tag ${app.availability}`}><BadgeCheck size={11}/>{availability}</span></div>
    <div className="mcp-publisher"><strong>{app.title}</strong><span>{app.publisher}</span></div>
    <p>{app.description}</p>
    <div className="mcp-capability-list">{app.capabilities.slice(0, 3).map((capability) => <span key={capability}>{capability}</span>)}</div>
    <div className="mcp-verified-domain"><LockKeyhole size={12}/><span>Official endpoint: {app.verifiedDomain} · sign-in may be required</span></div>
    <button className={`button ${app.installable ? 'primary' : ''}`} onClick={open}>{app.installable ? `Connect ${app.title}` : 'View requirements'}</button>
  </article>;
}

function CatalogCard({ server, install }: { server: McpCatalogServer; install: () => void }) {
  const endpointCount = server.endpoints.filter((endpoint) => endpoint.supported).length;
  return <article className="mcp-catalog-card panel"><div className="mcp-card-head"><AppBrandMark appId="mcp" title={server.title}/><span className="transport-tag">COMMUNITY HTTP</span></div><h2>{server.title}</h2><code>{server.registry_name}</code><p>{server.description || 'No server description was provided.'}</p><div className="mcp-card-meta"><span><ServerCog size={13}/>{endpointCount} endpoint{endpointCount === 1 ? '' : 's'}</span>{server.repository_url && <a href={server.repository_url} target="_blank" rel="noreferrer">Repository <ExternalLink size={12}/></a>}</div><button className="button" onClick={install}>Review community server</button></article>;
}

function InstallDialog({ target, cancel, complete }: { target: Exclude<InstallTarget, null>; cancel: () => void; complete: (connectionId: string) => void }) {
  const { report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const curated = target.kind === 'curated' ? target.app : null;
  const catalogServer = target.kind === 'catalog' ? target.server : null;
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'custom_headers' | 'oauth2'>(curated?.defaultAuth ?? 'none');
  const mutation = useMutation({
    mutationFn: api.createMcpConnection,
    onSuccess: async (connection) => {
      await queryClient.invalidateQueries({ queryKey: ['mcp-connections'] });
      if (authType === 'oauth2') {
        try {
          report(`${connection.name} added. Opening its secure OAuth authorization page…`);
          const authorization = await api.startMcpOAuth(connection.id);
          window.location.assign(authorization.authorizationUrl);
        } catch (cause) {
          reportError(message(cause, `${connection.name} was added, but OAuth could not start. Open Installed and select Authorize to retry.`));
          complete(connection.id);
        }
        return;
      }
      report(`${connection.name} added safely. Test the connection and review its tools before enabling access.`);
      complete(connection.id);
    },
    onError: (cause) => reportError(message(cause, 'Could not install MCP connection')),
  });
  if (curated && (!curated.installable || !curated.endpointUrl)) {
    return <div className="mcp-requirements">
      <AppBrandMark appId={curated.id} title={curated.title} color={curated.brandColor} size="large"/>
      <div><span className={`availability-tag ${curated.availability}`}>{curated.availability === 'limited' ? 'Limited access' : 'Desktop bridge required'}</span><h3>{curated.title} cannot be connected safely yet</h3><p>{curated.setupNote}</p></div>
      <div className="security-note"><ShieldCheck size={17}/><span>Woody will not pretend this integration works or weaken local-network protections to make the button clickable.</span></div>
      <div className="form-actions"><button className="button" type="button" onClick={cancel}>Close</button><a className="button primary" href={curated.docsUrl} target="_blank" rel="noreferrer">Official requirements <ExternalLink size={13}/></a></div>
    </div>;
  }
  const endpoint = catalogServer?.endpoints.find((candidate) => candidate.supported);
  const authModes = curated?.authModes ?? ['none', 'oauth2', 'bearer', 'custom_headers'] as const;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let auth: Record<string, unknown> = { type: authType };
    if (authType === 'bearer') auth = { type: 'bearer', token: String(form.get('token')) };
    if (authType === 'custom_headers') {
      try {
        auth = { type: 'custom_headers', headers: JSON.parse(String(form.get('headers'))) };
      } catch {
        reportError('Custom headers must be a valid JSON object');
        return;
      }
    }
    if (authType === 'oauth2' && curated?.requiresOAuthClient) {
      auth = {
        type: 'oauth2',
        clientId: String(form.get('oauthClientId')),
        clientSecret: String(form.get('oauthClientSecret')),
      };
    }
    mutation.mutate(target.kind === 'custom' ? {
      name: String(form.get('name')),
      description: String(form.get('description')),
      endpointUrl: String(form.get('endpointUrl')),
      transport: 'streamable-http',
      auth,
    } : target.kind === 'curated' ? {
      curatedAppId: target.app.id,
      auth,
    } : {
      catalogServerId: target.server.id,
      catalogEndpointId: endpoint?.id,
      auth,
    });
  };
  return <form className="form-grid" onSubmit={submit}>
    <div className="security-note"><ShieldCheck size={17}/><span>The connection starts <strong>off</strong> for safety. Authentication is encrypted by the backend and never returned to the browser.</span></div>
    {target.kind === 'custom' ? <><label>Connection name<input name="name" required minLength={2} placeholder="Company MCP"/></label><label>Streamable HTTP endpoint<input name="endpointUrl" required type="url" pattern="https://.*" placeholder="https://mcp.example.com/mcp"/></label><label>Description<input name="description" placeholder="What this server provides"/></label></> : curated ? <div className="install-summary curated"><div><AppBrandMark appId={curated.id} title={curated.title} color={curated.brandColor} size="small"/><span><strong>{curated.title}</strong><small>{curated.publisher} · {curated.category}</small></span></div><span>{curated.endpointUrl}</span><small><BadgeCheck size={11}/>Official endpoint on {curated.verifiedDomain}</small><p>{curated.setupNote}</p></div> : <div className="install-summary"><strong>{catalogServer?.title}</strong><span>{endpoint?.endpoint_url}</span><small>Community Registry metadata is unverified. Review the publisher and endpoint before continuing.</small></div>}
    <label>Authentication<select value={authType} onChange={(event) => setAuthType(event.target.value as typeof authType)}>{authModes.includes('none') && <option value="none">No authentication</option>}{authModes.includes('oauth2') && <option value="oauth2">OAuth 2.1 / PKCE</option>}{authModes.includes('bearer') && <option value="bearer">Bearer token</option>}{authModes.includes('custom_headers') && <option value="custom_headers">Custom secret headers</option>}</select></label>
    {authType === 'bearer' && <label>Bearer token<input name="token" type="password" required autoComplete="new-password"/></label>}
    {authType === 'custom_headers' && <label>Secret headers <small>JSON object; Host, Cookie and transport headers are blocked.</small><textarea name="headers" required defaultValue={'{\n  "Authorization": "Bearer …"\n}'}/></label>}
    {authType === 'oauth2' && curated?.requiresOAuthClient && <div className="google-oauth-fields"><label>OAuth client ID<input name="oauthClientId" required autoComplete="off" placeholder="…apps.googleusercontent.com"/></label><label>OAuth client secret<input name="oauthClientSecret" type="password" required autoComplete="new-password"/></label><small>Create a Google OAuth Web application and register <code>http://localhost:3002/v1/mcp/oauth/callback</code> as an authorized redirect URI.</small></div>}
    {authType === 'oauth2' && <div className="oauth-note"><KeyRound size={15}/><span>After adding the connection, Woody opens the provider’s authorization page. PKCE and state validation protect the callback.</span></div>}
    <div className="form-actions"><button className="button" type="button" onClick={cancel}>Cancel</button><button className="button primary" disabled={mutation.isPending || (target.kind === 'catalog' && !endpoint)}>{mutation.isPending ? <LoaderCircle className="spin" size={15}/> : <Plus size={15}/>} {authType === 'oauth2' ? 'Connect and authenticate' : 'Add connection'}</button></div>
  </form>;
}

function ConnectionDetails({ connection, configureAccess }: { connection: McpConnection; configureAccess: () => void }) {
  const { report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const needsAuthorization = connection.auth_type === 'oauth2' && !connection.authorized;
  const needsRepair = !needsAuthorization && connectionState(connection) === 'needs_attention';
  const canEnable = !connection.enabled && connection.health_status === 'healthy';
  const tools = useQuery({ queryKey: ['mcp-tools', connection.id], queryFn: () => api.mcpTools(connection.id) });
  const action = useMutation({
    mutationFn: async (kind: 'test' | 'discover' | 'toggle' | 'delete' | 'authorize') => {
      if (kind === 'test') return api.testMcpConnection(connection.id);
      if (kind === 'discover') return api.discoverMcpTools(connection.id);
      if (kind === 'toggle') return api.updateMcpConnection(connection.id, { enabled: !connection.enabled });
      if (kind === 'authorize') {
        const result = await api.startMcpOAuth(connection.id);
        window.location.assign(result.authorizationUrl);
        return result;
      }
      if (!window.confirm(`Uninstall “${connection.name}”? Credentials and agent access will be removed.`)) throw new Error('CANCELLED');
      return api.deleteMcpConnection(connection.id);
    },
    onSuccess: async (_result, kind) => {
      if (kind !== 'authorize') report(kind === 'test' ? `${connection.name} is healthy` : kind === 'discover' ? 'Tool discovery completed; review tools before enabling them' : kind === 'delete' ? `${connection.name} uninstalled and credentials purged` : `${connection.name} ${connection.enabled ? 'disabled' : 'enabled'}`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp-connections'] }),
        queryClient.invalidateQueries({ queryKey: ['mcp-tools', connection.id] }),
      ]);
    },
    onError: (cause) => { if (cause instanceof Error && cause.message !== 'CANCELLED') reportError(message(cause, 'MCP connection action failed')); },
  });
  return <div className="mcp-connection-detail"><div className="mcp-detail-head"><div><span className="eyebrow">Streamable HTTP</span><h2>{connection.name}</h2><p>{connection.description || connection.endpoint_url}</p></div><Status value={connectionState(connection)}/></div><dl className="connection-facts"><div><dt>Endpoint</dt><dd>{connection.endpoint_url}</dd></div><div><dt>Authentication</dt><dd>{connection.auth_type.replaceAll('_', ' ')}{connection.auth_type === 'oauth2' ? connection.authorized ? ' · connected' : ' · required' : ''}</dd></div><div><dt>Last healthy</dt><dd>{connection.last_success_at ? new Date(connection.last_success_at).toLocaleString() : 'Not tested'}</dd></div></dl>{needsAuthorization && <div className="mcp-auth-required"><KeyRound size={16}/><span><strong>Authorization required</strong><small>Connect your provider account before testing or discovering tools.</small></span></div>}{connection.last_error_message && !needsAuthorization && <div className="inline-error"><AlertTriangle size={15}/>{connection.last_error_message}</div>}<div className="mcp-actions">{connection.auth_type === 'oauth2' && <button className={needsAuthorization ? 'button primary' : 'button'} disabled={action.isPending} onClick={() => action.mutate('authorize')}><KeyRound size={14}/>{needsAuthorization ? 'Authorize account' : 'Reconnect OAuth'}</button>}<button className={`button${needsRepair ? ' primary' : ''}`} disabled={action.isPending || needsAuthorization} title={needsAuthorization ? 'Authorize the account first' : needsRepair ? 'Retest the connection and update its health state' : undefined} onClick={() => action.mutate('test')}><Activity size={14}/>{needsRepair ? 'Repair: test again' : 'Test connection'}</button><button className="button" disabled={action.isPending || needsAuthorization} title={needsAuthorization ? 'Authorize the account first' : undefined} onClick={() => action.mutate('discover')}><RefreshCw size={14}/>Discover tools</button>{(tools.data?.data.length ?? 0) > 0 && <button className="button" onClick={configureAccess}><ShieldCheck size={14}/>Configure access</button>}<button className={canEnable ? 'button primary' : 'button'} disabled={action.isPending || needsAuthorization || needsRepair || (!connection.enabled && !canEnable)} onClick={() => action.mutate('toggle')}>{connection.enabled ? <Unplug size={14}/> : <CheckCircle2 size={14}/>}{connection.enabled ? 'Disable' : 'Enable'}</button><button className="icon-button danger" disabled={action.isPending} title="Uninstall and purge credentials" onClick={() => action.mutate('delete')}><Trash2 size={15}/></button></div><ToolReview connection={connection} tools={tools.data?.data ?? []} loading={tools.isLoading}/></div>;
}

function AgentAccessDetails({ connection }: { connection: McpConnection }) {
  const tools = useQuery({ queryKey: ['mcp-tools', connection.id], queryFn: () => api.mcpTools(connection.id) });
  const agents = useQuery({ queryKey: ['mcp-agents', connection.id], queryFn: () => api.mcpConnectionAgents(connection.id) });
  return <AgentAccessEditor connection={connection} tools={tools.data?.data ?? []} agents={agents.data?.data ?? []} loading={tools.isLoading || agents.isLoading}/>;
}

function connectionState(connection: McpConnection) {
  if (connection.auth_type === 'oauth2' && !connection.authorized) return 'authentication_required';
  if (!connection.enabled) return 'disabled';
  if (connection.last_error_message || connection.consecutive_failures || connection.health_status !== 'healthy') return 'needs_attention';
  return 'connected';
}

function ToolReview({ connection, tools, loading }: { connection: McpConnection; tools: McpTool[]; loading: boolean }) {
  const { report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: ({ tool, body }: { tool: McpTool; body: Record<string, unknown> }) => api.updateMcpTool(connection.id, tool.id, body),
    onSuccess: async (tool) => { report(`${tool.title || tool.remote_name} access updated`); await queryClient.invalidateQueries({ queryKey: ['mcp-tools', connection.id] }); },
    onError: (cause) => reportError(message(cause, 'Could not update MCP tool')),
  });
  const bulkUpdate = useMutation({
    mutationFn: (mode: 'enable_read_only' | 'disable_all') => api.updateMcpTools(connection.id, mode),
    onSuccess: async (result) => {
      report(result.mode === 'enable_read_only' ? `${result.enabled} read-only tools enabled; write tools remain blocked` : 'All connection tools disabled');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp-tools', connection.id] }),
        queryClient.invalidateQueries({ queryKey: ['mcp-agents', connection.id] }),
      ]);
    },
    onError: (cause) => reportError(message(cause, 'Could not update MCP tools')),
  });
  const readOnlyCount = tools.filter((tool) => tool.risk_level === 'read').length;
  const enabledCount = tools.filter((tool) => tool.enabled).length;
  return <section className="mcp-subsection"><div className="section-title"><div><Wrench size={15}/><h3>Discovered tools</h3></div><span>{enabledCount} enabled · {tools.length} found</span></div>{loading ? <Loading text="Loading tools…"/> : tools.length ? <><div className="mcp-permission-guide"><ShieldCheck size={16}/><span><strong>Review tools before agents can use them</strong><small>Enable the safe read-only set now, then choose exactly which tools each agent receives below. Write and destructive actions stay blocked.</small></span><div><button className="button primary" disabled={bulkUpdate.isPending || !readOnlyCount || enabledCount === readOnlyCount} onClick={() => bulkUpdate.mutate('enable_read_only')}><ShieldCheck size={14}/>Enable {readOnlyCount} read-only tools</button>{enabledCount > 0 && <button className="button" disabled={bulkUpdate.isPending} onClick={() => bulkUpdate.mutate('disable_all')}>Disable all</button>}</div></div><div className="mcp-tool-list">{tools.map((tool) => <article key={tool.id}><label className="switch-row"><input type="checkbox" checked={tool.enabled} disabled={update.isPending || bulkUpdate.isPending} onChange={(event) => update.mutate({ tool, body: { enabled: event.target.checked } })}/><span><strong>{tool.title || tool.remote_name}</strong><small>{tool.description || tool.remote_name}</small></span></label><select aria-label={`Risk level for ${tool.title || tool.remote_name}`} value={tool.risk_level} disabled={update.isPending || bulkUpdate.isPending} onChange={(event) => update.mutate({ tool, body: { riskLevel: event.target.value } })}><option value="unknown">Unknown — confirm</option><option value="read">Read only</option><option value="write">Write</option><option value="external_write">External write — confirm</option><option value="destructive">Destructive — confirm</option></select></article>)}</div></> : <EmptyState Icon={RefreshCw} title="No tools discovered" text="Test the connection, then run tool discovery."/ >}</section>;
}

function AgentAccessEditor({ connection, tools, agents, loading }: { connection: McpConnection; tools: McpTool[]; agents: McpAgentAccess[]; loading: boolean }) {
  const { report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const [agentId, setAgentId] = useState('');
  const activeAgent = agents.find((agent) => agent.id === agentId);
  const [permission, setPermission] = useState<'read' | 'read_write'>('read');
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  useEffect(() => {
    setPermission(activeAgent?.permission_level ?? 'read');
    setSelectedTools(activeAgent?.tools.filter((entry) => entry.enabled).map((entry) => entry.toolId) ?? []);
  }, [activeAgent]);
  const save = useMutation({
    mutationFn: () => api.updateMcpAgentAccess(connection.id, agentId, { permissionLevel: permission, toolIds: selectedTools, enabled: true }),
    onSuccess: async () => { report('Agent MCP allowlist saved'); await queryClient.invalidateQueries({ queryKey: ['mcp-agents', connection.id] }); },
    onError: (cause) => reportError(message(cause, 'Could not save agent access')),
  });
  const enabledTools = useMemo(() => tools.filter((tool) => tool.enabled), [tools]);
  useEffect(() => {
    if (!agentId && agents.length === 1) setAgentId(agents[0].id);
  }, [agentId, agents]);
  return <section className="mcp-subsection" id={`mcp-agent-access-${connection.id}`}>
    <div className="section-title"><div><Users size={15}/><h3>Agent access</h3></div></div>
    {loading ? <Loading text="Loading agents…"/> : <div className="agent-access-form">
      <label>Agent<select value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">Choose an agent</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.role}</option>)}</select></label>
      {activeAgent && <div className="mcp-selected-agent"><AgentAvatar agent={activeAgent} size="sm"/><span><strong>{activeAgent.name}</strong><small>{activeAgent.role}</small></span></div>}
      {agentId && <>
        <label>Maximum permission<select value={permission} onChange={(event) => setPermission(event.target.value as typeof permission)}><option value="read">Read only</option><option value="read_write">Read and write</option></select></label>
        <fieldset><legend>Explicit tool allowlist</legend>{enabledTools.length > 0 && <div className="allowlist-actions"><button type="button" onClick={() => setSelectedTools(enabledTools.filter((tool) => tool.risk_level === 'read').map((tool) => tool.id))}>Select enabled read-only</button><button type="button" onClick={() => setSelectedTools([])}>Clear</button></div>}{tools.length ? tools.map((tool) => <label className={`check-row${tool.enabled ? '' : ' unavailable'}`} key={tool.id}><input type="checkbox" disabled={!tool.enabled} checked={selectedTools.includes(tool.id)} onChange={(event) => setSelectedTools((current) => event.target.checked ? [...current, tool.id] : current.filter((id) => id !== tool.id))}/><span>{tool.title || tool.remote_name}<small>{tool.enabled ? tool.risk_level.replaceAll('_', ' ') : 'Needs connection review'}</small></span></label>) : <p>Discover tools before assigning them.</p>}</fieldset>
        {!enabledTools.length && <p className="access-hint">No tools have passed connection review yet. Use “Enable read-only tools” above.</p>}
        <button className="button primary" disabled={save.isPending || !enabledTools.length || !selectedTools.length} title={!selectedTools.length ? 'Select at least one enabled tool' : undefined} onClick={() => save.mutate()}><ShieldCheck size={14}/>Save least-privilege access</button>
      </>}
    </div>}
  </section>;
}

function McpActivity() {
  const { report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const calls = useQuery({ queryKey: ['mcp-tool-calls'], queryFn: api.mcpToolCalls, refetchInterval: 5_000 });
  const decide = useMutation({
    mutationFn: ({ call, decision }: { call: McpToolCall; decision: 'approved' | 'rejected' }) => {
      if (decision === 'approved' && !window.confirm(`Approve this exact external action once?\n\n${call.action_summary}\n${call.target_summary ?? ''}`)) throw new Error('CANCELLED');
      return api.decideMcpToolCall(call.id, decision);
    },
    onSuccess: async (result) => {
      report(result.decision === 'approved' ? 'Action approved once; the exact saved call is resuming' : 'Action rejected; the agent will continue without executing it');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp-tool-calls'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace'] }),
      ]);
    },
    onError: (cause) => { if (cause instanceof Error && cause.message !== 'CANCELLED') reportError(message(cause, 'Could not resolve MCP confirmation')); },
  });
  if (calls.isLoading) return <Loading text="Loading MCP tool-call activity…"/>;
  if (calls.error) return <InlineError error={calls.error}/>;
  const entries = calls.data?.data ?? [];
  return <section className="panel mcp-activity">
    <div className="panel-header"><div><span className="eyebrow">Auditable execution</span><h2>Tool calls and confirmations</h2></div><button className="button" onClick={() => void calls.refetch()}><RefreshCw size={14}/>Refresh</button></div>
    {entries.length ? <div className="mcp-call-list">{entries.map((call) => <article key={call.id} className={call.status === 'awaiting_confirmation' ? 'pending' : ''}>
      {call.agent_id ? <AgentAvatar agent={{ id: call.agent_id, name: call.agent_name ?? 'Agent', role: call.agent_role ?? 'AI agent', avatar_config: call.agent_avatar ?? {} }} size="sm" status={call.status === 'failed' ? 'error' : call.status === 'running' ? 'busy' : undefined}/> : <div className="call-icon">{call.status === 'awaiting_confirmation' ? <ShieldCheck size={17}/> : call.status === 'succeeded' ? <CheckCircle2 size={17}/> : call.status === 'failed' ? <AlertTriangle size={17}/> : <Activity size={17}/>}</div>}
      <div><div className="call-title"><strong>{call.tool_title || call.remote_name}</strong><Status value={call.status}/></div><p>{call.action_summary || `${call.agent_name ?? 'Agent'} used ${call.connection_name}`}</p>{call.target_summary && <code>{call.target_summary}</code>}<small>{new Date(call.requested_at).toLocaleString()} · {call.agent_name ?? 'Unknown agent'}{call.duration_ms ? ` · ${call.duration_ms} ms` : ''}</small>{call.error_message && <span className="call-error">{call.error_code}: {call.error_message}</span>}</div>
      {call.status === 'awaiting_confirmation' && call.confirmation_status === 'pending' && <div className="confirmation-actions"><button className="button danger" disabled={decide.isPending} onClick={() => decide.mutate({ call, decision: 'rejected' })}>Reject</button><button className="button primary" disabled={decide.isPending} onClick={() => decide.mutate({ call, decision: 'approved' })}>Approve once</button></div>}
    </article>)}</div> : <EmptyState Icon={Activity} title="No MCP tool calls yet" text="Read calls, failures and pending external-write confirmations will appear here."/>}
  </section>;
}

function Loading({ text }: { text: string }) { return <div className="mcp-loading"><LoaderCircle className="spin" size={18}/><span>{text}</span></div>; }
function InlineError({ error }: { error: unknown }) { return <div className="inline-error"><AlertTriangle size={15}/>{message(error, 'MCP request failed')}</div>; }
function message(cause: unknown, fallback: string) { return cause instanceof Error ? cause.message : fallback; }
