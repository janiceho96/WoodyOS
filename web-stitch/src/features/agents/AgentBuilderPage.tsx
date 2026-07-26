import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, BrainCircuit, Check, ChevronLeft, ChevronRight, Code2, Database, FileText, Globe2, House, LoaderCircle, Play, Rocket, Save, Settings, ShieldCheck, Sparkles, Wrench, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, isApiTool, type Agent, type AgentAvatarConfig, type AgentPromptTone } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { Status } from '../../components/ui';
import { humanize } from '../../lib/format';
import { AgentAvatar } from '../../components/agents/AgentAvatar';
import { AgentAvatarPicker } from '../../components/agents/AgentAvatarPicker';
import { mcpAccessSummary } from '../mcp/agentMcpAccess';
import { normalizeAgentApiToolIds } from '../tools/agentToolAccess';

type Draft = {
  name: string; role: string; goal: string; personality: string; instructions: string; model: string;
  temperature: number; maxTokens: number; topP: number; status: Agent['status'];
  capabilities: { webBrowser: boolean; codeInterpreter: boolean; knowledgeBase: boolean };
  toolIds: string[];
  avatar: AgentAvatarConfig | null;
};
type BuilderStep = 'purpose' | 'instructions' | 'resources' | 'model' | 'review';

const steps: Array<{ id: BuilderStep; label: string; hint: string }> = [
  { id: 'purpose', label: 'Purpose', hint: 'Identity and outcome' },
  { id: 'instructions', label: 'Instructions', hint: 'Rules and format' },
  { id: 'resources', label: 'Resources', hint: 'Knowledge and access' },
  { id: 'model', label: 'Model', hint: 'Quality and budget' },
  { id: 'review', label: 'Review', hint: 'Safety and publish' },
];

const promptTones: Array<{ id: AgentPromptTone; label: string; description: string }> = [
  { id: 'professional', label: 'Professional', description: 'Polished and dependable' },
  { id: 'friendly', label: 'Friendly', description: 'Warm and approachable' },
  { id: 'analytical', label: 'Analytical', description: 'Evidence-led and precise' },
  { id: 'creative', label: 'Creative', description: 'Imaginative with boundaries' },
  { id: 'concise', label: 'Concise', description: 'Direct and action-focused' },
];

function fromAgent(agent?: Agent, defaultModel = ''): Draft {
  return {
    name: agent?.name ?? '', role: agent?.role ?? '', goal: agent?.goal ?? '', personality: agent?.personality ?? '',
    instructions: agent?.instructions ?? '', model: agent?.model ?? defaultModel,
    temperature: agent?.model_config?.temperature ?? 0.2, maxTokens: agent?.model_config?.maxTokens ?? 4096,
    topP: agent?.model_config?.topP ?? 1, status: agent?.status === 'archived' ? 'draft' : agent?.status ?? 'draft',
    capabilities: agent?.capabilities ?? { webBrowser: false, codeInterpreter: false, knowledgeBase: true },
    toolIds: agent?.tool_ids ?? [],
    avatar: agent?.avatar_config && 'type' in agent.avatar_config ? agent.avatar_config as AgentAvatarConfig : null,
  };
}

export function AgentBuilderPage() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, report, reportError } = useWorkspace();
  const agent = useMemo(() => data.agents.find((item) => item.id === agentId), [data.agents, agentId]);
  const defaultModel = data.runtime?.defaultModel ?? '';
  const [draft, setDraft] = useState<Draft>(() => fromAgent(agent, defaultModel));
  const [step, setStep] = useState<BuilderStep>('purpose');
  const [formError, setFormError] = useState('');
  const [promptTone, setPromptTone] = useState<AgentPromptTone>('professional');
  const [promptBackup, setPromptBackup] = useState<Draft | null>(null);
  const [promptError, setPromptError] = useState('');
  useEffect(() => {
    setDraft((current) => {
      if (agent) return fromAgent(agent, defaultModel);
      return current.model || !defaultModel ? current : { ...current, model: defaultModel };
    });
  }, [agent, defaultModel]);

  const validation = {
    purpose: draft.name.trim().length >= 2 && draft.role.trim().length >= 2 && draft.goal.trim().length >= 2,
    instructions: draft.instructions.trim().length >= 10,
    resources: true,
    model: draft.model.trim().length >= 2 && draft.maxTokens >= 128,
    review: false,
  };
  const ready = validation.purpose && validation.model;
  const apiTools = data.tools.filter(isApiTool);
  const enabledApiTools = apiTools.filter((tool) => tool.enabled);
  const normalizedToolAssignment = normalizeAgentApiToolIds(draft.toolIds, data.tools);
  const activeTools = enabledApiTools.filter((tool) => normalizedToolAssignment.toolIds.includes(tool.id));
  const activeWebTools = activeTools.filter((tool) => tool.permissions.includes('web.read'));
  const webReady = !draft.capabilities.webBrowser || activeWebTools.length > 0;
  const currentIndex = steps.findIndex((item) => item.id === step);
  const mcpAccess = useQuery({
    queryKey: ['agent-mcp-access', agent?.id],
    queryFn: () => api.agentMcpAccess(agent!.id),
    enabled: Boolean(agent?.id),
  });
  const mcpAccessState = !agent ? 'unsaved' : mcpAccess.isLoading ? 'loading' : mcpAccess.isError ? 'error' : 'loaded';
  const mcpSummary = mcpAccessState === 'unsaved'
    ? 'Save this agent before assigning MCP access'
    : mcpAccessState === 'error'
      ? 'MCP access could not be loaded'
      : mcpAccessState === 'loading'
      ? 'Loading MCP access…'
      : mcpAccessSummary(mcpAccess.data);
  const mcpReviewStatus = mcpAccessState === 'loaded'
    ? mcpAccess.data?.connections.length ? 'warning' : 'success'
    : mcpAccessState === 'error' ? 'warning' : 'neutral';

  const mutation = useMutation({
    mutationFn: async (status: Agent['status']) => {
      if (!validation.purpose) throw new Error('Complete the agent name, role, and goal before saving.');
      if (!validation.model) throw new Error('Choose a valid model and output-token limit.');
      const body = {
        name: draft.name.trim(), role: draft.role.trim(), goal: draft.goal.trim(), personality: draft.personality.trim() || null,
        instructions: draft.instructions, model: draft.model.trim(), status,
        modelConfig: { temperature: Number(draft.temperature), maxTokens: Number(draft.maxTokens), topP: Number(draft.topP) },
        capabilities: draft.capabilities, toolIds: normalizedToolAssignment.toolIds,
        memoryConfig: { shortTerm: true, longTerm: true, knowledgeBase: draft.capabilities.knowledgeBase },
        ...(draft.avatar ? { avatar: draft.avatar } : {}),
      };
      return agent ? api.updateAgent(agent.id, body) : api.createAgent(body);
    },
    onSuccess: async (saved, status) => {
      setFormError('');
      report(status === 'active' ? `${saved.name} is published and ready to run` : `${saved.name} saved as a draft`);
      await queryClient.invalidateQueries({ queryKey: ['workspace'] });
      navigate(`/agents/${saved.id}/edit`, { replace: true });
    },
    onError: (cause) => {
      const message = cause instanceof Error ? cause.message : 'Could not save agent';
      setFormError(message); reportError(message);
    },
  });

  const promptMutation = useMutation({
    mutationFn: () => api.generateAgentPrompt({
      name: draft.name.trim(),
      role: draft.role.trim(),
      goal: draft.goal.trim(),
      tone: promptTone,
    }),
    onSuccess: (generated) => {
      setPromptBackup(draft);
      setDraft((current) => ({
        ...current,
        goal: generated.goal,
        personality: generated.personality,
        instructions: generated.instructions,
      }));
      setPromptError('');
      setStep('instructions');
      report(`${promptTones.find((item) => item.id === generated.tone)?.label ?? 'Agent'} prompt generated for review`);
    },
    onError: (cause) => {
      const message = cause instanceof Error ? cause.message : 'Could not generate the agent prompt';
      setPromptError(message);
      reportError(message);
    },
  });

  const toggleCapability = (key: keyof Draft['capabilities']) => setDraft((current) => ({ ...current, capabilities: { ...current.capabilities, [key]: !current.capabilities[key] } }));
  const toggleTool = (id: string) => setDraft((current) => ({ ...current, toolIds: current.toolIds.includes(id) ? current.toolIds.filter((toolId) => toolId !== id) : [...current.toolIds, id] }));
  const move = (direction: -1 | 1) => setStep(steps[Math.max(0, Math.min(steps.length - 1, currentIndex + direction))].id);
  const hasUnsavedChanges = JSON.stringify(draft) !== JSON.stringify(fromAgent(agent, defaultModel));
  const leaveBuilder = (path: string) => {
    if (mutation.isPending || promptMutation.isPending) return;
    if (hasUnsavedChanges && !window.confirm('Leave the agent editor? Unsaved changes will be lost.')) return;
    navigate(path);
  };
  const canGeneratePrompt = draft.name.trim().length >= 2 || draft.role.trim().length >= 2;
  const generatePrompt = () => {
    if (!canGeneratePrompt || promptMutation.isPending) return;
    if ((draft.goal.trim() || draft.personality.trim() || draft.instructions.trim())
      && !window.confirm('Generate a new prompt? This will replace the current outcome, working style, and instructions after generation succeeds.')) return;
    setPromptError('');
    promptMutation.mutate();
  };
  const undoGeneratedPrompt = () => {
    if (!promptBackup) return;
    setDraft(promptBackup);
    setPromptBackup(null);
    report('Restored the prompt you had before generation');
  };

  return <div className="builder-page guided-builder">
    <div className="builder-toolbar">
      <div className="builder-breadcrumbs">
        <button type="button" onClick={() => leaveBuilder('/dashboard')}><House size={14}/>Home</button><ChevronRight size={12}/>
        <button type="button" onClick={() => leaveBuilder('/agents')}>Agents</button><ChevronRight size={12}/>
        <strong>{agent ? agent.name : 'New agent draft'}</strong><Status value={agent?.status ?? 'draft'}/>
      </div>
      <div>{!agent && <button className="button" onClick={() => leaveBuilder('/agents/library?tab=generate')}><Sparkles size={15}/>Generate from prompt</button>}<button className="button" onClick={() => leaveBuilder(agent ? `/agents/${agent.id}?section=configure` : '/agents')}><ChevronLeft size={15}/>{agent ? 'Back to agent' : 'Back to agents'}</button><button className="button" disabled={mutation.isPending || !ready} onClick={() => mutation.mutate('draft')}><Save size={15}/>Save draft</button><button className="button primary" disabled={mutation.isPending || !ready} onClick={() => mutation.mutate('active')}>{mutation.isPending ? <LoaderCircle className="spin" size={15}/> : <Rocket size={15}/>}Publish agent</button></div>
    </div>
    {formError && <div className="inline-error builder-error"><AlertTriangle size={15}/><span><strong>Agent was not saved.</strong>{formError}</span></div>}
    {normalizedToolAssignment.removedCount > 0 && <div className="inline-warning builder-error"><AlertTriangle size={15}/><span>{normalizedToolAssignment.removedCount} unavailable tool assignment{normalizedToolAssignment.removedCount === 1 ? '' : 's'} will be removed when you save.</span></div>}
    <div className="guided-builder-layout">
      <aside className="builder-steps" aria-label="Agent builder steps">
        <div><span className="eyebrow">Build progress</span><strong>{ready ? 'Ready to review' : 'Draft in progress'}</strong></div>
        {steps.map((item, index) => <button key={item.id} className={step === item.id ? 'active' : ''} onClick={() => setStep(item.id)}><i>{validation[item.id] || (item.id === 'review' && ready) ? <Check size={13}/> : index + 1}</i><span><strong>{item.label}</strong><small>{item.hint}</small></span><ChevronRight size={14}/></button>)}
        <div className="builder-safety-note"><ShieldCheck size={17}/><span><strong>Least access by default</strong><small>Tools remain unavailable until you explicitly select them.</small></span></div>
      </aside>

      <main className="builder-step-content">
        {step === 'purpose' && <BuilderSection Icon={Bot} eyebrow="Step 1" title="Give this agent one clear responsibility" description="A focused agent is easier to test, safer to operate, and produces more consistent work.">
          <AgentAvatarPicker agent={agent} name={draft.name} role={draft.role} value={draft.avatar} onChange={(avatar) => setDraft((current) => ({ ...current, avatar }))}/>
          <label>Agent name <span>*</span><input disabled={promptMutation.isPending} value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Research Analyst"/></label>
          <label>Role <span>*</span><input disabled={promptMutation.isPending} value={draft.role} maxLength={240} onChange={(event) => setDraft({ ...draft, role: event.target.value })} placeholder="Senior market researcher"/><small>Describe what kind of specialist this is.</small></label>
          <section className="prompt-assistant" aria-labelledby="prompt-assistant-title">
            <div className="prompt-assistant-head"><span><Sparkles size={17}/></span><div><h3 id="prompt-assistant-title">Generate the full agent prompt</h3><p>Choose a voice, then let Woody draft the outcome, working style, process, safety rules, and output format.</p></div></div>
            <fieldset disabled={promptMutation.isPending}>
              <legend>Default tone</legend>
              <div className="prompt-tone-grid">{promptTones.map((tone) => <button type="button" key={tone.id} className={promptTone === tone.id ? 'active' : ''} aria-pressed={promptTone === tone.id} onClick={() => setPromptTone(tone.id)}><strong>{tone.label}</strong><small>{tone.description}</small></button>)}</div>
            </fieldset>
            {promptError && <div className="inline-error"><AlertTriangle size={15}/><span>{promptError}</span></div>}
            <div className="prompt-assistant-action"><small>Uses one request from your configured AI provider. Nothing is saved automatically.</small><button type="button" className="button primary" disabled={!canGeneratePrompt || promptMutation.isPending} onClick={generatePrompt}>{promptMutation.isPending ? <LoaderCircle className="spin" size={15}/> : <Sparkles size={15}/>} {promptMutation.isPending ? 'Writing prompt…' : 'Generate full prompt'}</button></div>
          </section>
          <label>Outcome this agent owns <span>*</span><textarea disabled={promptMutation.isPending} className="builder-large-field" value={draft.goal} maxLength={5000} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} placeholder="Research a market and return a cited comparison of the strongest competitors."/><small>Write an observable result rather than a broad topic.</small></label>
          <label>Working style <small>Optional</small><input disabled={promptMutation.isPending} value={draft.personality} maxLength={80} onChange={(event) => setDraft({ ...draft, personality: event.target.value })} placeholder="Analytical, concise, cautious"/></label>
        </BuilderSection>}

        {step === 'instructions' && <BuilderSection Icon={FileText} eyebrow="Step 2" title="Set rules and an output contract" description="Tell the agent how to work, what to avoid, and how a successful answer should be structured.">
          {promptBackup && <div className="generated-prompt-note"><Sparkles size={17}/><span><strong>AI-generated draft ready to review</strong><small>Edit anything below before saving. Your previous text is still available.</small></span><button type="button" className="button" onClick={undoGeneratedPrompt}>Undo generation</button></div>}
          <div className="instruction-prompts"><button onClick={() => setDraft({ ...draft, instructions: `${draft.instructions}${draft.instructions ? '\n\n' : ''}## Process\n1. Verify the request and available context.\n2. Complete the work step by step.\n3. Check the result against the goal.` })}>Add process</button><button onClick={() => setDraft({ ...draft, instructions: `${draft.instructions}${draft.instructions ? '\n\n' : ''}## Boundaries\n- Do not invent facts.\n- State uncertainty clearly.\n- Ask for approval before external write actions.` })}>Add safety rules</button><button onClick={() => setDraft({ ...draft, instructions: `${draft.instructions}${draft.instructions ? '\n\n' : ''}## Output\nReturn a concise Markdown report with a summary, findings, evidence, and recommended next actions.` })}>Add output format</button></div>
          <label>Agent instructions <small>Markdown supported</small><textarea className="instruction-editor" value={draft.instructions} maxLength={20000} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} placeholder="Describe the process, boundaries, quality checks, and required output…"/></label>
          <div className="field-foot"><span>≈ {Math.ceil(draft.instructions.length / 4)} prompt tokens</span><span>{draft.instructions.length.toLocaleString()} / 20,000 characters</span></div>
          {!validation.instructions && <div className="gentle-warning"><AlertTriangle size={15}/>Instructions are optional, but at least a short process and output format are recommended.</div>}
        </BuilderSection>}

        {step === 'resources' && <BuilderSection Icon={Database} eyebrow="Step 3" title="Choose what this agent may access" description="Capabilities and integrations are explicit. Selecting a tool grants access only to this agent.">
          <div className="resource-group"><div><h3>Capabilities</h3><p>Enable only what the responsibility requires.</p></div>{([
            ['webBrowser', 'Web access', 'Use connected web-capable tools. This does not create a browser by itself.', Globe2],
            ['codeInterpreter', 'Code-oriented work', 'Allow compatible execution tools for code and data tasks.', Code2],
            ['knowledgeBase', 'Workspace knowledge', 'Search indexed workspace documents. Per-document assignment is not available yet.', Database],
          ] as const).map(([key, label, text, Icon]) => <button className={`permission-card ${draft.capabilities[key] ? 'active' : ''}`} key={key} onClick={() => toggleCapability(key)} type="button"><span><Icon size={18}/></span><div><strong>{label}</strong><small>{text}</small></div><i>{draft.capabilities[key] ? <Check size={13}/> : <X size={13}/>}</i></button>)}</div>
          <div className="resource-group"><div><h3>API Tools</h3><p>Choose enabled API tools to save in this agent’s API Tool access list.</p></div>{enabledApiTools.length ? <div className="permission-list">{enabledApiTools.map((tool) => <label key={tool.id}><input type="checkbox" checked={normalizedToolAssignment.toolIds.includes(tool.id)} onChange={() => toggleTool(tool.id)}/><span><strong>{tool.name}</strong><small>{tool.kind.toUpperCase()} · {tool.description || 'No description'}</small></span><b>{normalizedToolAssignment.toolIds.includes(tool.id) ? 'Allowed' : 'No access'}</b></label>)}</div> : <div className="resource-empty"><Wrench size={18}/><span><strong>No enabled API Tools</strong><small>Connect or enable an API Tool before assigning it to this agent.</small></span><button className="button" onClick={() => navigate('/api-tools')}>Open API Tools</button></div>}</div>
          <div className="resource-group"><div><h3>MCP access</h3><p>MCP connections and actions use separate per-agent allowlists. Connection IDs are never added to this agent’s API Tool list.</p><strong>{mcpSummary}</strong></div><button type="button" className="button" onClick={() => navigate('/mcp?tab=access')}>Manage MCP access</button></div>
          {draft.capabilities.webBrowser && !activeWebTools.length && <div className="inline-warning"><AlertTriangle size={16}/><span>Web access is enabled, but no Web Research tool is assigned. The agent still cannot search the internet. <button type="button" className="text-button" onClick={() => navigate('/api-tools')}>Configure Web Research</button></span></div>}
          {!draft.capabilities.webBrowser && activeWebTools.length > 0 && <div className="inline-warning"><AlertTriangle size={16}/>Assigned web tools will remain unavailable until Web access is enabled above.</div>}
        </BuilderSection>}

        {step === 'model' && <BuilderSection Icon={BrainCircuit} eyebrow="Step 4" title="Choose quality and usage limits" description="The workspace default is usually the safest starting point. Advanced controls are available when the task requires them.">
          <label>Foundation model <span>*</span><input value={draft.model} maxLength={160} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder={defaultModel || 'Provider model name'}/><small>{data.runtime ? `Current ${data.runtime.provider.replace('-', ' ')} workspace default: ${defaultModel}` : 'Loading workspace runtime…'}</small></label>
          <details className="advanced-settings"><summary><Settings size={16}/><span><strong>Advanced model controls</strong><small>Adjust creativity and response size</small></span><ChevronRight size={15}/></summary><div><label>Temperature <strong className="field-value">{draft.temperature}</strong><input type="range" min="0" max="2" step="0.1" value={draft.temperature} onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })}/><small>Lower values are more predictable; higher values are more varied.</small></label><label>Maximum output tokens<input type="number" min="128" max="128000" value={draft.maxTokens} onChange={(event) => setDraft({ ...draft, maxTokens: Number(event.target.value) })}/></label><label>Top P <strong className="field-value">{draft.topP}</strong><input type="range" min="0" max="1" step="0.05" value={draft.topP} onChange={(event) => setDraft({ ...draft, topP: Number(event.target.value) })}/></label></div></details>
          <div className="model-summary"><Zap size={18}/><span><strong>{draft.model || 'No model selected'}</strong><small>Up to {draft.maxTokens.toLocaleString()} output tokens · temperature {draft.temperature}</small></span></div>
        </BuilderSection>}

        {step === 'review' && <BuilderSection Icon={ShieldCheck} eyebrow="Step 5" title="Review before publishing" description="Publishing makes this agent available for tasks. It does not automatically run work or grant new permissions.">
          <div className="agent-review-card"><div className="review-identity"><AgentAvatar agent={{ name: draft.name || 'Untitled agent', role: draft.role, avatar_config: draft.avatar ?? {} }} size="lg"/><span><small>{draft.role || 'Role missing'}</small><h2>{draft.name || 'Untitled agent'}</h2><p>{draft.goal || 'Goal missing'}</p></span></div><ReviewRow label="Instructions" value={draft.instructions ? `${Math.ceil(draft.instructions.length / 4)} estimated prompt tokens` : 'No detailed instructions'} good={validation.instructions}/><ReviewRow label="Knowledge" value={draft.capabilities.knowledgeBase ? 'May search workspace knowledge' : 'No knowledge access'} good={draft.capabilities.knowledgeBase}/><ReviewRow label="API Tools" value={activeTools.length ? activeTools.map((tool) => tool.name).join(', ') : 'No API Tool access'} good={!activeTools.length}/><ReviewRow label="MCP access" value={mcpSummary} status={mcpReviewStatus}/><ReviewRow label="Web research" value={!draft.capabilities.webBrowser ? 'Not enabled' : activeWebTools.length ? activeWebTools.map((tool) => tool.name).join(', ') : 'Enabled but no web tool assigned'} good={webReady}/><ReviewRow label="Code execution" value={draft.capabilities.codeInterpreter ? 'Enabled for assigned code tools' : 'Not enabled'} good={!draft.capabilities.codeInterpreter}/><ReviewRow label="Model" value={`${draft.model || 'Missing'} · max ${draft.maxTokens.toLocaleString()} tokens`} good={validation.model}/></div>
          <div className="publish-boundary"><ShieldCheck size={19}/><div><strong>What happens when you publish</strong><p>The configuration is saved and the agent becomes selectable for tasks. No task starts automatically, no external action is performed, and MCP permissions remain separately enforced.</p></div></div>
          <div className="review-actions"><button className="button" disabled={mutation.isPending || !ready} onClick={() => mutation.mutate('draft')}><Save size={15}/>Save as draft</button><button className="button primary" disabled={mutation.isPending || !ready} onClick={() => mutation.mutate('active')}><Rocket size={15}/>{agent?.status === 'active' ? 'Update published agent' : 'Publish agent'}</button>{agent && <button className="button" onClick={() => navigate(`/agents/${agent.id}?section=history`)}><Play size={15}/>Open task history</button>}</div>
        </BuilderSection>}

        <footer className="builder-step-footer"><button className="button" disabled={currentIndex === 0} onClick={() => move(-1)}><ChevronLeft size={15}/>Previous</button><span>Step {currentIndex + 1} of {steps.length}</span>{currentIndex < steps.length - 1 ? <button className="button primary" onClick={() => move(1)}>Continue<ChevronRight size={15}/></button> : <button className="button" onClick={() => setStep('purpose')}>Review from start</button>}</footer>
      </main>

      <aside className="builder-live-summary">
        <span className="eyebrow">Live summary</span><AgentAvatar agent={{ name: draft.name || 'Untitled agent', role: draft.role, avatar_config: draft.avatar ?? {} }} size="lg"/><h2>{draft.name || 'Untitled agent'}</h2><p>{draft.role || 'Add a role to define this specialist.'}</p>
        <div><small>Outcome</small><strong>{draft.goal || 'Not defined yet'}</strong></div>
        <div><small>Access</small><span>{Object.entries(draft.capabilities).map(([key, enabled]) => <i className={enabled ? 'enabled' : ''} key={key}>{enabled ? <Check size={11}/> : <X size={11}/>} {humanize(key)}</i>)}</span></div>
        <div><small>API Tools</small><strong>{activeTools.length ? activeTools.map((tool) => tool.name).join(', ') : 'None assigned'}</strong></div>
        <div><small>MCP access</small><strong>{mcpSummary}</strong></div>
        <div><small>Model</small><strong>{draft.model || 'Not selected'}</strong></div>
        <div className="summary-readiness"><Status value={ready ? 'ready' : 'draft'}/><span>{ready ? 'Required fields complete' : 'Complete Purpose and Model'}</span></div>
      </aside>
    </div>
  </div>;
}

function BuilderSection({ Icon, eyebrow, title, description, children }: { Icon: typeof Bot; eyebrow: string; title: string; description: string; children: React.ReactNode }) {
  return <section className="guided-section"><header><span><Icon size={20}/></span><div><small className="eyebrow">{eyebrow}</small><h1>{title}</h1><p>{description}</p></div></header><div className="guided-fields">{children}</div></section>;
}

function ReviewRow({ label, value, good, status }: { label: string; value: string; good?: boolean; status?: 'success' | 'warning' | 'neutral' }) {
  const resolvedStatus = status ?? (good ? 'success' : 'warning');
  return <div className="review-row"><span className={resolvedStatus === 'success' ? 'good' : resolvedStatus} aria-label={`${label} review status: ${resolvedStatus}`}>{resolvedStatus === 'success' ? <Check size={13}/> : resolvedStatus === 'neutral' ? <LoaderCircle className="spin" size={13}/> : <AlertTriangle size={13}/>}</span><small>{label}</small><strong>{value}</strong></div>;
}
