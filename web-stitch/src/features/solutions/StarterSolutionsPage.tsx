import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowDown, ArrowRight, ArrowUp, BookOpen, Bot, Boxes, BrainCircuit, CheckCircle2,
  FileText, GitBranch, LoaderCircle, LockKeyhole, Play, Plus, Rocket, Save, ShieldCheck,
  Sparkles, Users, WandSparkles, X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import {
  api, type Agent, type AgentSolution, type AgentSolutionAgent, type AgentSolutionInstallation, type FileAsset, type Tool, type WorkflowRun,
} from '../../api';
import { useWorkspace } from '../../app/workspace';
import { EmptyState, Modal, PageHeader, Status } from '../../components/ui';
import { AgentAvatar } from '../../components/agents/AgentAvatar';
import { AttachmentPicker } from '../../components/files/AttachmentPicker';
import { handleTabListKeyDown } from '../../lib/a11y';
import { compact } from '../../lib/format';
import './solutions.css';
import { AgentHubTabs } from '../agents/AgentHubTabs';

type Tab = 'starters' | 'generate' | 'installed';

export function StarterSolutionsPage() {
  const { session } = useWorkspace();
  const canInstall = session.workspace.role === 'owner' || session.workspace.role === 'admin';
  const location = useLocation();
  const inAgentLibrary = location.pathname === '/agents/library';
  const [params, setParams] = useSearchParams();
  const initial = params.get('tab');
  const initialAttachmentIds = (params.get('files') ?? '').split(',').filter(Boolean).slice(0, 10);
  const [tab, setTabState] = useState<Tab>(initial === 'generate' || initial === 'installed' ? initial : 'starters');
  const setTab = (next: Tab) => { setTabState(next); setParams(next === 'starters' ? {} : { tab: next }); };
  return <div className="solutions-page">
    {inAgentLibrary && <AgentHubTabs active="library"/>}
    <PageHeader
      eyebrow={inAgentLibrary ? 'Agent Library' : 'Multi-agent systems'}
      title={inAgentLibrary ? 'Start with a ready-made agent' : 'Create an agent system'}
      description={inAgentLibrary ? 'Browse proven single and multi-agent templates, generate an agent from your prompt, or continue an installed draft.' : 'Start from a proven template or turn a written goal into one reviewable draft with agents, workflow, knowledge, integrations, permissions, and estimated usage.'}
      actions={<button className="button primary" onClick={() => setTab('generate')}><WandSparkles size={15}/>Generate from prompt</button>}
    />
    {!canInstall && <div className="inline-error" role="status">Only workspace owners and administrators can install or save solution drafts.</div>}
    <div className="solution-tabs" role="tablist" aria-label="Create agent system sections" onKeyDown={handleTabListKeyDown}>
      <button id="create-tab-starters" type="button" role="tab" aria-selected={tab === 'starters'} aria-controls="create-panel-starters" tabIndex={tab === 'starters' ? 0 : -1} className={tab === 'starters' ? 'active' : ''} onClick={() => setTab('starters')}><Boxes size={15}/>Templates</button>
      <button id="create-tab-generate" type="button" role="tab" aria-selected={tab === 'generate'} aria-controls="create-panel-generate" tabIndex={tab === 'generate' ? 0 : -1} className={tab === 'generate' ? 'active' : ''} onClick={() => setTab('generate')}><Sparkles size={15}/>From a prompt</button>
      <button id="create-tab-installed" type="button" role="tab" aria-selected={tab === 'installed'} aria-controls="create-panel-installed" tabIndex={tab === 'installed' ? 0 : -1} className={tab === 'installed' ? 'active' : ''} onClick={() => setTab('installed')}><GitBranch size={15}/>Drafts</button>
    </div>
    {tab === 'starters' && <section id="create-panel-starters" role="tabpanel" aria-labelledby="create-tab-starters"><StarterCatalog canInstall={canInstall} openInstalled={() => setTab('installed')}/></section>}
    {tab === 'generate' && <section id="create-panel-generate" role="tabpanel" aria-labelledby="create-tab-generate"><PromptCompiler canInstall={canInstall} initialPrompt={params.get('prompt') ?? ''} initialAttachmentIds={initialAttachmentIds} openInstalled={() => setTab('installed')}/></section>}
    {tab === 'installed' && <section id="create-panel-installed" role="tabpanel" aria-labelledby="create-tab-installed"><InstalledSolutions canInstall={canInstall}/></section>}
  </div>;
}

function StarterCatalog({ canInstall, openInstalled }: { canInstall: boolean; openInstalled: () => void }) {
  const { data, report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const starters = useQuery({ queryKey: ['starter-solutions'], queryFn: api.starterSolutions });
  const installations = useQuery({ queryKey: ['agent-solution-installations'], queryFn: api.agentSolutionInstallations });
  const [selected, setSelected] = useState<AgentSolution | null>(null);
  const [toolSelections, setToolSelections] = useState<Record<string, string>>({});
  const install = useMutation({
    mutationFn: ({ solution, copy, toolIdsByAgentKey }: { solution: AgentSolution; copy: boolean; toolIdsByAgentKey?: Record<string, string[]> }) =>
      api.installStarterSolution(solution.slug, copy, toolIdsByAgentKey),
    onSuccess: async (result) => {
      report(`${result.solution.name} installed as a draft`);
      setSelected(null);
      setToolSelections({});
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agent-solution-installations'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace'] }),
      ]);
      openInstalled();
    },
    onError: (cause) => reportError(message(cause, 'Could not install starter solution')),
  });
  if (starters.isLoading) return <Loading text="Loading starter solution catalog…"/>;
  if (starters.error) return <InlineError error={starters.error}/>;
  const installedSlugs = new Set((installations.data?.data ?? []).filter((item) => item.source_type === 'starter').map((item) => item.solution_slug));
  const catalogSolutions = [...(starters.data?.data ?? [])].sort((left, right) =>
    Number(right.category === 'Tool-ready Agents') - Number(left.category === 'Tool-ready Agents'));
  const openPreview = (solution: AgentSolution) => {
    setToolSelections({});
    setSelected(solution);
  };
  return <>
    <section className="solution-safety panel"><ShieldCheck size={21}/><div><strong>Safe installation boundary</strong><p>Every solution installs as a disabled draft. Tool-ready agents receive only the compatible read-only tools you choose in the review; standard templates receive no grants.</p></div><span>READ-ONLY DEFAULT</span></section>
    <section className="tool-ready-library-heading"><div><span className="eyebrow">Tool-ready agents appear first</span><h2>Agent templates</h2><p>Start with a focused tool-ready agent or continue to the specialist multi-agent systems below.</p></div><Link className="button" to="/tools?section=web">Manage research tools</Link></section>
    <div className="solution-grid">{catalogSolutions.map((solution) => {
      const installed = installedSlugs.has(solution.slug);
      const requirements = solutionToolRequirements(solution);
      const readyRequirements = requirements.filter(({ requirement }) => matchingTools(requirement, data.tools).length > 0).length;
      const toolReady = requirements.length > 0;
      return <article className="solution-card panel" key={solution.slug}>
        <div className="solution-card-top"><span className="solution-glyph"><BrainCircuit size={21}/></span><Status value={installed ? 'active' : solution.difficulty}/></div>
        <span className="eyebrow">{solution.category} · v{solution.version}</span>
        <h2>{solution.name}</h2><p>{solution.description}</p>
        <div className="solution-metrics"><span><Users size={13}/>{solution.agents.length} agents</span><span><Play size={13}/>{solution.estimatedModelCalls} calls</span><span><FileText size={13}/>{compact(solution.estimatedTokenRange.minimum)}–{compact(solution.estimatedTokenRange.maximum)} tokens</span></div>
        {toolReady && <div className={`template-tool-readiness ${readyRequirements === requirements.length ? 'ready' : 'warning'}`}><span>{readyRequirements === requirements.length ? <CheckCircle2 size={14}/> : <AlertTriangle size={14}/>}<strong>{readyRequirements}/{requirements.length} required tools connected</strong></span><small>{requirements.map(({ requirement }) => requirement.label).join(' · ')}</small></div>}
        <div className="solution-agent-stack">{solution.agents.map((agent) => <span key={agent.key}><AgentAvatar agent={{ name: agent.name, role: agent.role, avatar_config: {} }} size="xs" decorative/>{agent.name}</span>)}</div>
        <div className="solution-card-actions"><button className="button" onClick={() => openPreview(solution)}>Preview</button>{canInstall ? <button className="button primary" disabled={installed || install.isPending} onClick={() => toolReady ? openPreview(solution) : install.mutate({ solution, copy: false })}>{installed ? <CheckCircle2 size={14}/> : <Plus size={14}/>} {installed ? 'Installed' : toolReady ? 'Choose tools' : 'Install draft'}</button> : <small>Administrator access required to install</small>}</div>
      </article>;
    })}</div>
    {selected && <SolutionPreview
      solution={selected}
      close={() => { setSelected(null); setToolSelections({}); }}
      actionLabel={installedSlugs.has(selected.slug) ? 'Install another copy' : 'Install as draft'}
      canInstall={canInstall}
      pending={install.isPending}
      tools={data.tools}
      toolSelections={toolSelections}
      setToolSelection={(key, toolId) => setToolSelections((current) => ({ ...current, [key]: toolId }))}
      install={() => {
        const copy = installedSlugs.has(selected.slug);
        if (copy && !window.confirm('Install a separate copy of this solution and its agents?')) return;
        install.mutate({ solution: selected, copy, toolIdsByAgentKey: selectedToolAssignments(selected, toolSelections) });
      }}
    />}
  </>;
}

function PromptCompiler({ canInstall, openInstalled, initialPrompt = '', initialAttachmentIds = [] }: {
  openInstalled: () => void;
  canInstall: boolean;
  initialPrompt?: string;
  initialAttachmentIds?: string[];
}) {
  const { report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'automatic' | 'single' | 'multi'>('automatic');
  const [prompt, setPrompt] = useState(initialPrompt);
  const [attachments, setAttachments] = useState<FileAsset[]>([]);
  const [persistPrompt, setPersistPrompt] = useState(false);
  const [proposal, setProposal] = useState<AgentSolution | null>(null);
  const proposalReviewRef = useRef<HTMLElement>(null);
  const initializedAttachments = useRef(false);
  const files = useQuery({ queryKey: ['files'], queryFn: api.files, staleTime: 15_000 });
  useEffect(() => {
    if (initializedAttachments.current || !files.data) return;
    initializedAttachments.current = true;
    const requested = new Set(initialAttachmentIds);
    setAttachments(files.data.data.filter((file) => requested.has(file.id)));
  }, [files.data, initialAttachmentIds]);
  const attachmentsReady = attachments.every((file) => file.status === 'ready');
  const compile = useMutation({
    mutationFn: () => api.compileAgentSolution({ prompt, mode, attachmentIds: attachments.map((file) => file.id) }),
    onSuccess: ({ solution }) => {
      setProposal(solution);
      report(`Generated a ${solution.agents.length}-agent proposal for review`, {
        label: 'Review proposal',
        onClick: () => {
          const review = proposalReviewRef.current;
          if (!review) return;
          const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          review.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
          window.requestAnimationFrame(() => review.focus({ preventScroll: true }));
        },
      });
    },
    onError: (cause) => reportError(message(cause, 'Could not compile this prompt')),
  });
  const install = useMutation({
    mutationFn: () => api.installAgentSolution({
      solution: proposal!,
      sourcePrompt: persistPrompt ? prompt : undefined,
      persistPrompt,
    }),
    onSuccess: async (result) => {
      report(`${result.solution.name} saved as an inactive draft`);
      setProposal(null); setPrompt(''); setAttachments([]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agent-solution-installations'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace'] }),
      ]);
      openInstalled();
    },
    onError: (cause) => reportError(message(cause, 'Could not save generated solution')),
  });
  const updateAgent = (index: number, field: keyof Pick<AgentSolutionAgent, 'name' | 'role' | 'goal' | 'instructions'>, value: string) => {
    setProposal((current) => current && ({ ...current, agents: current.agents.map((agent, agentIndex) => agentIndex === index ? { ...agent, [field]: value } : agent) }));
  };
  const moveAgent = (index: number, delta: number) => {
    setProposal((current) => {
      if (!current) return current;
      const target = index + delta;
      if (target < 0 || target >= current.agents.length) return current;
      const agents = [...current.agents];
      [agents[index], agents[target]] = [agents[target], agents[index]];
      return rebuildLinearWorkflow({ ...current, agents });
    });
  };
  return <div className="prompt-compiler-layout">
    <section className="prompt-input-panel panel">
      <div className="panel-header"><div><span className="eyebrow">Untrusted input boundary</span><h2>Paste your full prompt</h2></div><LockKeyhole size={20}/></div>
      <p>The compiler analyzes this text as data. It cannot call tools, send messages, create files, or grant permissions.</p>
      <div className="compile-mode" role="group" aria-label="Agent generation mode">
        {(['automatic', 'single', 'multi'] as const).map((value) => <button key={value} className={mode === value ? 'active' : ''} onClick={() => setMode(value)}>{value === 'automatic' ? 'Auto detect' : value === 'single' ? 'Single agent' : 'Multi-agent'}</button>)}
      </div>
      <label>ChatGPT prompt<textarea className="prompt-source" value={prompt} maxLength={50_000} onChange={(event) => setPrompt(event.target.value)} placeholder="Paste the complete prompt describing the job, required output, rules, inputs and constraints…"/></label>
      <div className="prompt-attachments">
        <span>Reference files <small>Only relevant extracted passages are sent to the model.</small></span>
        <AttachmentPicker value={attachments} onChange={setAttachments} defaultScope="saved" allowedScopes={['saved', 'knowledge']} compact uploadLabel="Add files"/>
      </div>
      <div className="prompt-stats"><span>≈ {Math.ceil(prompt.length / 4).toLocaleString()} input tokens</span><span>{prompt.length.toLocaleString()} / 50,000 characters</span></div>
      <button className="button primary compile-button" disabled={compile.isPending || prompt.trim().length < 20 || !attachmentsReady} onClick={() => compile.mutate()}>{compile.isPending ? <LoaderCircle className="spin" size={15}/> : <Sparkles size={15}/>}Generate proposal</button>
      <div className="compiler-boundaries"><span><X size={13}/>No execution</span><span><X size={13}/>No automatic tools</span><span><X size={13}/>No external writes</span></div>
    </section>
    <section ref={proposalReviewRef} className="proposal-panel panel" tabIndex={-1} aria-label="Generated agent proposal review">
      {!proposal ? <EmptyState Icon={WandSparkles} title={compile.isPending ? 'Compiling your agent system' : 'No proposal yet'} text={compile.isPending ? 'The configured AI provider is producing a validated structured draft.' : 'Paste a prompt and generate a proposal. Nothing is created until you review and save it.'}/> : <>
        <div className="proposal-heading"><div><span className="eyebrow">{proposal.source} proposal</span><input aria-label="Solution name" value={proposal.name} onChange={(event) => setProposal({ ...proposal, name: event.target.value })}/><textarea aria-label="Solution description" value={proposal.description} onChange={(event) => setProposal({ ...proposal, description: event.target.value })}/></div><button className="icon-button" aria-label="Cancel proposal" onClick={() => setProposal(null)}><X size={17}/></button></div>
        <div className="proposal-stats"><span><strong>{proposal.agents.length}</strong> agents</span><span><strong>{proposal.estimatedModelCalls}</strong> model calls</span><span><strong>{compact(proposal.estimatedTokenRange.minimum)}–{compact(proposal.estimatedTokenRange.maximum)}</strong> tokens</span></div>
        <section className="proposal-section"><div className="section-title"><h3>Editable agent team</h3><small>Drag-equivalent order controls rebuild the workflow safely.</small></div><div className="proposal-agents">{proposal.agents.map((agent, index) => <article key={agent.key}>
          <div className="proposal-agent-head"><span><AgentAvatar agent={{ name: agent.name, role: agent.role, avatar_config: {} }} size="sm"/><strong>{agent.key}</strong></span><div><button className="icon-button" disabled={index === 0} onClick={() => moveAgent(index, -1)} aria-label={`Move ${agent.name} earlier`}><ArrowUp size={14}/></button><button className="icon-button" disabled={index === proposal.agents.length - 1} onClick={() => moveAgent(index, 1)} aria-label={`Move ${agent.name} later`}><ArrowDown size={14}/></button></div></div>
          <label>Name<input value={agent.name} onChange={(event) => updateAgent(index, 'name', event.target.value)}/></label>
          <label>Role<input value={agent.role} onChange={(event) => updateAgent(index, 'role', event.target.value)}/></label>
          <label>Goal<textarea value={agent.goal} onChange={(event) => updateAgent(index, 'goal', event.target.value)}/></label>
          <label>Instructions<textarea className="agent-instructions" value={agent.instructions} onChange={(event) => updateAgent(index, 'instructions', event.target.value)}/></label>
        </article>)}</div></section>
        <section className="proposal-section"><div className="section-title"><h3>Editable workflow preview</h3><small>Acyclic · sequential · real agent handoffs</small></div><WorkflowPreview solution={proposal}/></section>
        <ProposalRequirements solution={proposal}/>
        <section className="proposal-section"><h3>Expected Markdown output</h3><div className="markdown-output contract-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{proposal.expectedMarkdownOutput}</ReactMarkdown></div></section>
        <label className="persist-prompt"><input type="checkbox" checked={persistPrompt} onChange={(event) => setPersistPrompt(event.target.checked)}/><span><strong>Store the original prompt with this draft</strong><small>Off by default. If enabled, it is encrypted at rest and never returned by the API.</small></span></label>
        <div className="proposal-actions"><button className="button" onClick={() => setProposal(null)}>Cancel</button>{canInstall ? <button className="button primary" disabled={install.isPending} onClick={() => install.mutate()}>{install.isPending ? <LoaderCircle className="spin" size={15}/> : <Save size={15}/>}Save as draft</button> : <small>Administrator access required to save this draft.</small>}</div>
      </>}
    </section>
  </div>;
}

function InstalledSolutions({ canInstall }: { canInstall: boolean }) {
  const { data, report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const installations = useQuery({ queryKey: ['agent-solution-installations'], queryFn: api.agentSolutionInstallations, refetchInterval: 10_000 });
  const [inputs, setInputs] = useState<Record<string, Record<string, string>>>({});
  const [runContext, setRunContext] = useState<{ installationId: string; runId: string } | null>(null);
  const testRun = useQuery({
    queryKey: ['solution-test-run', runContext?.runId],
    queryFn: () => api.workflowRun(runContext!.runId),
    enabled: Boolean(runContext),
    refetchInterval: (query) => ['queued', 'running', 'awaiting_approval'].includes(query.state.data?.status ?? '') ? 2_000 : false,
  });
  useEffect(() => {
    if (testRun.data && ['completed', 'failed', 'cancelled'].includes(testRun.data.status)) {
      void queryClient.invalidateQueries({ queryKey: ['agent-solution-installations'] });
    }
  }, [queryClient, testRun.data]);
  const test = useMutation({
    mutationFn: (installation: AgentSolutionInstallation) => {
      if (!window.confirm(`Run a real ${installation.solution.estimatedModelCalls}-stage test? This uses your configured AI provider and consumes tokens.`)) throw new Error('CANCELLED');
      return api.testAgentSolution(installation.id, inputs[installation.id] ?? {});
    },
    onSuccess: (run, installation) => { setRunContext({ installationId: installation.id, runId: run.id }); report('Draft test workflow queued'); },
    onError: (cause) => { if (cause instanceof Error && cause.message !== 'CANCELLED') reportError(message(cause, 'Could not test solution')); },
  });
  const activate = useMutation({
    mutationFn: (installation: AgentSolutionInstallation) => {
      if (!window.confirm(`Activate ${installation.solution.agents.length} agents and enable its workflow? Tool and MCP access will remain unassigned.`)) throw new Error('CANCELLED');
      return api.activateAgentSolution(installation.id);
    },
    onSuccess: async () => {
      report('Solution activated; agents and workflow are now available');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agent-solution-installations'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace'] }),
      ]);
    },
    onError: (cause) => { if (cause instanceof Error && cause.message !== 'CANCELLED') reportError(message(cause, 'Could not activate solution')); },
  });
  if (installations.isLoading) return <Loading text="Loading installed solutions…"/>;
  if (installations.error) return <InlineError error={installations.error}/>;
  const records = installations.data?.data ?? [];
  if (!records.length) return <EmptyState Icon={GitBranch} title="No solution drafts installed" text="Install a starter or generate a custom solution first."/>;
  return <div className="installed-solutions">
    {records.map((installation) => <article className="installed-solution panel" key={installation.id}>
      <div className="installed-head"><div><span className="eyebrow">{installation.source_type} · v{installation.solution_version}</span><h2>{installation.solution_name}</h2><p>{installation.solution.description}</p></div><Status value={installation.status}/></div>
      <div className="installed-resources"><span><Bot size={14}/><strong>{installation.solution.agents.length}</strong> draft agents</span><span><Users size={14}/>1 team</span><span><GitBranch size={14}/>1 workflow</span><span><LockKeyhole size={14}/>0 automatic tool grants</span></div>
      <SolutionToolReadiness installation={installation} tools={data.tools} agents={data.agents}/>
      <WorkflowPreview solution={installation.solution}/>
      {installation.status === 'draft' && <div className="solution-test-form"><div><span className="eyebrow">Safe test input</span><p>Draft testing runs the real workflow without activating agents or assigning integrations.</p></div><div className="test-input-grid">{installation.solution.requiredInputs.map((field) => <label key={field.key}>{field.label}{field.required && <span> *</span>}<input value={inputs[installation.id]?.[field.key] ?? ''} placeholder={field.example ?? field.description} onChange={(event) => setInputs((current) => ({ ...current, [installation.id]: { ...current[installation.id], [field.key]: event.target.value } }))}/></label>)}</div><div className="installed-actions"><span>{installation.last_test_status ? <>Last test: <Status value={installation.last_test_status}/></> : 'A successful test is required before activation.'}</span>{canInstall ? <><button className="button" disabled={test.isPending} onClick={() => test.mutate(installation)}>{test.isPending ? <LoaderCircle className="spin" size={14}/> : <Play size={14}/>}Run test · {installation.solution.estimatedModelCalls} calls</button><button className="button primary" disabled={activate.isPending || installation.last_test_status !== 'completed'} title={installation.last_test_status !== 'completed' ? 'Complete a successful test first' : undefined} onClick={() => activate.mutate(installation)}><Rocket size={14}/>Activate solution</button></> : <small>Administrator access required to change this draft.</small>}</div></div>}
      {installation.status === 'active' && <div className="active-solution-note"><CheckCircle2 size={16}/><span><strong>Active</strong><small>Use the saved workflow from Workflow Designer. Assign reviewed MCP tools per agent when needed.</small></span></div>}
      {runContext?.installationId === installation.id && testRun.data && <TestRunResult run={testRun.data}/>}
    </article>)}
  </div>;
}

function SolutionToolReadiness({ installation, tools, agents }: { installation: AgentSolutionInstallation; tools: Tool[]; agents: Agent[] }) {
  const requirements = solutionToolRequirements(installation.solution);
  if (requirements.length) {
    const checks = requirements.map(({ agent, requirement }) => {
      const agentId = installation.resources.agentIds?.[agent.key];
      const installedAgent = agents.find((item) => item.id === agentId);
      const assignedTools = tools.filter((tool) => installedAgent?.tool_ids.includes(tool.id));
      return {
        requirement,
        ready: Boolean(installedAgent?.capabilities.webBrowser)
          && assignedTools.some((tool) => matchingTools(requirement, [tool]).length > 0),
      };
    });
    const readyCount = checks.filter((check) => check.ready).length;
    const ready = readyCount === checks.length;
    const needsJobs = checks.some((check) => !check.ready && check.requirement.permissions.includes('jobs.read'));
    return <section className={`web-readiness ${ready ? 'ready' : 'warning'}`}>
      {ready ? <CheckCircle2 size={18}/> : <AlertTriangle size={18}/>}<div>
        <strong>{ready ? 'Required tools assigned' : `${readyCount}/${checks.length} required tools assigned`}</strong>
        <p>{ready ? 'This draft has the explicit read-only tool access declared by its template.' : `Missing: ${checks.filter((check) => !check.ready).map((check) => check.requirement.label).join(', ')}.`}</p>
      </div>
      {!ready && <div><Link className="button" to={needsJobs ? '/tools?section=jobs' : '/tools?section=web'}>Connect missing tool</Link><Link className="button" to="/agents">Review agent access</Link></div>}
    </section>;
  }
  if (!installation.solution.recommendedIntegrations.some((integration) => integration.id === 'web-search')) return null;
  const searchTools = tools.filter((tool) => tool.enabled && tool.permissions.includes('web.search'));
  const installedAgentIds = new Set(Object.values(installation.resources.agentIds ?? {}));
  const assignedAgents = agents.filter((agent) => installedAgentIds.has(agent.id)
    && agent.capabilities.webBrowser
    && agent.tool_ids.some((toolId) => searchTools.some((tool) => tool.id === toolId)));
  const ready = assignedAgents.length > 0;
  return <section className={`web-readiness ${ready ? 'ready' : 'warning'}`}>
    {ready ? <CheckCircle2 size={18}/> : <AlertTriangle size={18}/>}<div>
      <strong>{ready ? 'Web research ready' : searchTools.length ? 'Web research is connected but not assigned' : 'Web research is not connected'}</strong>
      <p>{ready
        ? `${assignedAgents.length} solution agent${assignedAgents.length === 1 ? '' : 's'} can search the public web. Page reading and Reddit remain separate permissions.`
        : searchTools.length
          ? 'For least privilege, Woody did not grant it automatically. Open the research agents, enable Web access, and select a search tool.'
          : 'This solution can still use your task input and Knowledge, but it cannot collect current public evidence until you connect a search provider.'}</p>
    </div>
    <div>{!searchTools.length && <Link className="button" to="/tools?section=web">Connect search</Link>}<Link className="button" to="/agents">Review agent access</Link></div>
  </section>;
}

function TestRunResult({ run }: { run: WorkflowRun }) {
  const text = outputText(run.output);
  return <section className="test-run-result"><div className="section-title"><div><span className="eyebrow">Latest test run</span><h3>Test output</h3></div><Status value={run.status}/></div>{['queued', 'running'].includes(run.status) ? <Loading text="Specialist agents are running in sequence…"/> : text ? <div className="markdown-output"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div> : <pre className="json-output">{JSON.stringify(run.output, null, 2)}</pre>}</section>;
}

type ToolRequirement = NonNullable<AgentSolutionAgent['toolRequirements']>[number];

function solutionToolRequirements(solution: AgentSolution) {
  return solution.agents.flatMap((agent) => (agent.toolRequirements ?? []).map((requirement) => ({ agent, requirement })));
}

function matchingTools(requirement: ToolRequirement, tools: Tool[]) {
  return tools.filter((tool) =>
    tool.enabled
    && tool.kind === 'internal'
    && requirement.permissions.some((permission) => tool.permissions.includes(permission)));
}

function toolSelectionKey(agentKey: string, requirementKey: string) {
  return `${agentKey}:${requirementKey}`;
}

function selectedToolAssignments(solution: AgentSolution, selections: Record<string, string>) {
  return Object.fromEntries(solution.agents.map((agent) => [
    agent.key,
    [...new Set((agent.toolRequirements ?? [])
      .map((requirement) => selections[toolSelectionKey(agent.key, requirement.key)])
      .filter((toolId): toolId is string => Boolean(toolId)))],
  ]));
}

function SolutionPreview({
  solution, close, install, pending, actionLabel, canInstall, tools = [], toolSelections = {}, setToolSelection,
}: {
  solution: AgentSolution;
  close: () => void;
  install: () => void;
  pending: boolean;
  actionLabel: string;
  canInstall: boolean;
  tools?: Tool[];
  toolSelections?: Record<string, string>;
  setToolSelection?: (key: string, toolId: string) => void;
}) {
  const requirements = solutionToolRequirements(solution);
  const missingRequired = requirements.some(({ agent, requirement }) =>
    requirement.required && !toolSelections[toolSelectionKey(agent.key, requirement.key)]);
  return <Modal title={solution.name} close={close} wide><div className="solution-preview">
    <p>{solution.description}</p>
    <div className="proposal-stats"><span><strong>{solution.agents.length}</strong> agents</span><span><strong>{solution.estimatedModelCalls}</strong> calls</span><span><strong>{compact(solution.estimatedTokenRange.minimum)}–{compact(solution.estimatedTokenRange.maximum)}</strong> tokens</span></div>
    <WorkflowPreview solution={solution}/>
    <div className="preview-agent-list">{solution.agents.map((agent) => <article key={agent.key}><AgentAvatar agent={{ name: agent.name, role: agent.role, avatar_config: {} }} size="md"/><div><strong>{agent.name}</strong><small>{agent.role}</small><p>{agent.goal}</p></div></article>)}</div>
    {requirements.length > 0 && <section className="tool-grant-review"><div className="section-title"><div><span className="eyebrow">Explicit read-only access</span><h3>Choose tools for this agent</h3></div><ShieldCheck size={18}/></div><p>Only the tools selected below will be assigned. Woody validates that each connection is enabled, compatible, and read-only before creating the draft.</p><div>{requirements.map(({ agent, requirement }) => {
      const key = toolSelectionKey(agent.key, requirement.key);
      const matches = matchingTools(requirement, tools);
      return <label key={key}><span><strong>{requirement.label}{requirement.required ? ' *' : ''}</strong><small>{requirement.purpose}</small></span>{matches.length ? <select value={toolSelections[key] ?? ''} required={requirement.required} onChange={(event) => setToolSelection?.(key, event.target.value)}><option value="">Choose a connected tool</option>{matches.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}</select> : <span className="missing-tool"><AlertTriangle size={14}/>Not connected <Link to={requirement.permissions.includes('jobs.read') ? '/tools?section=jobs' : '/tools?section=web'}>Connect tool</Link></span>}</label>;
    })}</div></section>}
    <ProposalRequirements solution={solution}/>
    <div className="proposal-actions"><button className="button" onClick={close}>Cancel</button>{canInstall ? <button className="button primary" disabled={pending || missingRequired} title={missingRequired ? 'Connect and choose every required read-only tool first' : undefined} onClick={install}>{pending ? <LoaderCircle className="spin" size={15}/> : <Plus size={15}/>} {requirements.length ? 'Install draft with selected tools' : actionLabel}</button> : <small>Administrator access required to install this draft.</small>}</div>
  </div></Modal>;
}

function WorkflowPreview({ solution }: { solution: AgentSolution }) {
  return <div className="solution-workflow" aria-label={`${solution.name} workflow`}>
    {solution.workflow.nodes.map((node, index) => {
      const agent = node.agentKey ? solution.agents.find((item) => item.key === node.agentKey) : null;
      return <div className="solution-workflow-step" key={node.id}><span className={node.type}>{agent ? <AgentAvatar agent={{ name: agent.name, role: agent.role, avatar_config: {} }} size="xs" decorative/> : node.type === 'trigger' ? <Play size={14}/> : node.type === 'approval' ? <ShieldCheck size={14}/> : <FileText size={14}/>}</span><small>{node.type}</small><strong>{agent?.name ?? (node.type === 'trigger' ? 'Your input' : node.type === 'approval' ? 'Human approval' : 'Markdown result')}</strong>{index < solution.workflow.nodes.length - 1 && <ArrowRight className="workflow-arrow" size={15}/>}</div>;
    })}
  </div>;
}

function ProposalRequirements({ solution }: { solution: AgentSolution }) {
  const knowledgeAgents = solution.agents.filter((agent) => agent.capabilities.knowledgeBase);
  return <section className="proposal-requirements">
    <div><h3>Inputs</h3>{solution.requiredInputs.map((field) => <span key={field.key}><strong>{field.label}{field.required ? ' *' : ''}</strong><small>{field.description}</small></span>)}</div>
    <div><h3>Knowledge</h3>{knowledgeAgents.length ? <span><BookOpen size={13}/><small><strong>Workspace Knowledge · read access</strong>{knowledgeAgents.length} of {solution.agents.length} agents can retrieve indexed workspace context. No document is copied into the draft.</small></span> : <span><strong>No Knowledge access</strong><small>These agents use only the supplied input and upstream handoffs.</small></span>}</div>
    <div><h3>Suggested integrations</h3>{solution.recommendedIntegrations.length ? solution.recommendedIntegrations.map((integration) => <span key={integration.id}><strong>{integration.name} · {integration.permission.replace('_', ' ')}</strong><small>{integration.purpose} · not automatically granted</small></span>) : <span><strong>No integration required</strong><small>This proposal can work from task input and workspace knowledge.</small></span>}</div>
    <div><h3>Permissions and approval</h3>{solution.requiredPermissions.length ? solution.requiredPermissions.map((permission) => <span key={`${permission.resource}-${permission.level}`}><ShieldCheck size={13}/><small><strong>{permission.resource} · {permission.level.replace('_', ' ')}</strong>{permission.reason}{permission.requiresConfirmation ? ' · confirmation required' : ''}</small></span>) : <span><ShieldCheck size={13}/><small><strong>No external permission required</strong>Tool access is not granted during draft installation.</small></span>}{solution.humanApprovalRequirements.map((requirement, index) => <span key={`${requirement}-${index}`}><LockKeyhole size={13}/><small>{requirement}</small></span>)}</div>
    <div><h3>Questions and warnings</h3>{[...solution.missingQuestions, ...solution.warnings].length ? [...solution.missingQuestions, ...solution.warnings].map((item, index) => <span key={`${item}-${index}`}><AlertTriangle size={13}/><small>{item}</small></span>) : <span><CheckCircle2 size={13}/><small>No unresolved compiler warnings.</small></span>}</div>
  </section>;
}

function rebuildLinearWorkflow(solution: AgentSolution): AgentSolution {
  const agentNodes: AgentSolution['workflow']['nodes'] = solution.agents.map((agent, index) => ({
    id: `stage_${index + 1}`,
    type: 'agent',
    agentKey: agent.key,
    config: { responsibility: agent.goal, expectedOutput: index === solution.agents.length - 1 ? solution.expectedMarkdownOutput : 'Structured Markdown handoff' },
  }));
  const needsApproval = solution.requiredPermissions.some((permission) => permission.level !== 'read' || permission.requiresConfirmation)
    || solution.recommendedIntegrations.some((integration) => integration.permission === 'read_write');
  const nodes: AgentSolution['workflow']['nodes'] = [
    { id: 'trigger', type: 'trigger', config: { event: 'manual' } },
    ...agentNodes,
    ...(needsApproval ? [{ id: 'approval', type: 'approval' as const, config: { prompt: 'Review the proposed external action before continuing.' } }] : []),
    { id: 'output', type: 'output', config: { fromNodeId: agentNodes.at(-1)!.id, format: 'markdown' } },
  ];
  return {
    ...solution,
    team: { ...solution.team, managerAgentKey: solution.agents.at(-1)!.key },
    workflow: { ...solution.workflow, nodes, edges: nodes.slice(0, -1).map((node, index) => ({ source: node.id, target: nodes[index + 1].id })) },
  };
}

function outputText(value: unknown) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'text' in value && typeof (value as { text?: unknown }).text === 'string') return (value as { text: string }).text;
  return null;
}
function Loading({ text }: { text: string }) { return <div className="solution-loading"><LoaderCircle className="spin" size={18}/>{text}</div>; }
function InlineError({ error }: { error: unknown }) { return <div className="inline-error"><AlertTriangle size={15}/>{message(error, 'Could not load Starter Solutions')}</div>; }
function message(cause: unknown, fallback: string) { return cause instanceof Error ? cause.message : fallback; }
