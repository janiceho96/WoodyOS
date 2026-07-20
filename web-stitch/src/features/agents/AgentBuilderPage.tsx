import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, Check, ChevronRight, Code2, Database, Globe2, LoaderCircle, Play, Rocket, Save, Settings, Sparkles, TerminalSquare, Wrench, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Agent } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { Status } from '../../components/ui';
import { humanize } from '../../lib/format';

type Draft = {
  name: string; role: string; goal: string; personality: string; instructions: string; model: string;
  temperature: number; maxTokens: number; topP: number; status: Agent['status'];
  capabilities: { webBrowser: boolean; codeInterpreter: boolean; knowledgeBase: boolean };
  toolIds: string[];
};

function fromAgent(agent?: Agent, defaultModel = ''): Draft {
  return {
    name: agent?.name ?? '', role: agent?.role ?? '', goal: agent?.goal ?? '', personality: agent?.personality ?? '',
    instructions: agent?.instructions ?? '', model: agent?.model ?? defaultModel,
    temperature: agent?.model_config?.temperature ?? 0.2, maxTokens: agent?.model_config?.maxTokens ?? 4096,
    topP: agent?.model_config?.topP ?? 1, status: agent?.status === 'archived' ? 'draft' : agent?.status ?? 'active',
    capabilities: agent?.capabilities ?? { webBrowser: false, codeInterpreter: false, knowledgeBase: true },
    toolIds: agent?.tool_ids ?? [],
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
  const [formError, setFormError] = useState('');
  useEffect(() => {
    setDraft((current) => {
      if (agent) return fromAgent(agent, defaultModel);
      return current.model || !defaultModel ? current : { ...current, model: defaultModel };
    });
  }, [agent?.id, defaultModel]);

  const mutation = useMutation({
    mutationFn: async (status: Agent['status']) => {
      if (draft.name.trim().length < 2 || draft.role.trim().length < 2 || draft.goal.trim().length < 2) {
        throw new Error('Name, role, and goal each need at least 2 characters.');
      }
      const body = {
        name: draft.name.trim(), role: draft.role.trim(), goal: draft.goal.trim(), personality: draft.personality.trim() || null,
        instructions: draft.instructions, model: draft.model.trim(), status,
        modelConfig: { temperature: Number(draft.temperature), maxTokens: Number(draft.maxTokens), topP: Number(draft.topP) },
        capabilities: draft.capabilities, toolIds: draft.toolIds,
        memoryConfig: { shortTerm: true, longTerm: true, knowledgeBase: draft.capabilities.knowledgeBase },
      };
      return agent ? api.updateAgent(agent.id, body) : api.createAgent(body);
    },
    onSuccess: async (saved) => {
      setFormError('');
      report(agent ? 'Agent configuration updated' : 'Agent deployed');
      await queryClient.invalidateQueries({ queryKey: ['workspace'] });
      navigate(`/agents/${saved.id}/edit`, { replace: true });
    },
    onError: (cause) => {
      const message = cause instanceof Error ? cause.message : 'Could not save agent';
      setFormError(message); reportError(message);
    },
  });

  const toggleCapability = (key: keyof Draft['capabilities']) => setDraft((current) => ({ ...current, capabilities: { ...current.capabilities, [key]: !current.capabilities[key] } }));
  const toggleTool = (id: string) => setDraft((current) => ({ ...current, toolIds: current.toolIds.includes(id) ? current.toolIds.filter((toolId) => toolId !== id) : [...current.toolIds, id] }));
  return <div className="builder-page">
    <div className="builder-toolbar">
      <div><span className="eyebrow">Builder <ChevronRight size={12}/></span><strong>{agent ? agent.name : 'New agent'}</strong><Status value={agent?.status ?? 'draft'}/></div>
      <div>{!agent && <button className="button" onClick={() => navigate('/solutions?tab=generate')}><Sparkles size={15}/>Generate from prompt</button>}<button className="button" onClick={() => navigate('/agents')}>Discard</button><button className="button" disabled={mutation.isPending} onClick={() => mutation.mutate('draft')}><Save size={15}/>Save draft</button><button className="button primary" disabled={mutation.isPending} onClick={() => mutation.mutate('active')}>{mutation.isPending ? <LoaderCircle className="spin" size={15}/> : <Rocket size={15}/>}Deploy agent</button></div>
    </div>
    {formError && <div className="inline-error"><AlertTriangle size={15}/>{formError}</div>}
    <div className="builder-layout">
      <section className="builder-pane identity-pane">
        <div className="builder-section-title"><Bot size={18}/><h2>Identity</h2></div>
        <label>Agent name <span>*</span><input value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. Research Analyst"/></label>
        <label>Role <span>*</span><input value={draft.role} maxLength={240} onChange={(event) => setDraft({ ...draft, role: event.target.value })} placeholder="e.g. Senior market researcher"/></label>
        <label>Goal <span>*</span><textarea value={draft.goal} maxLength={5000} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} placeholder="Define the outcome this agent owns."/></label>
        <label>Personality<input value={draft.personality} maxLength={80} onChange={(event) => setDraft({ ...draft, personality: event.target.value })} placeholder="Analytical, concise, cautious"/></label>
        <div className="builder-section-title"><TerminalSquare size={18}/><h2>Instructions</h2></div>
        <label>System prompt <small>Markdown supported</small><textarea className="instruction-editor" value={draft.instructions} maxLength={20000} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} placeholder="Rules, boundaries, preferred response format…"/></label>
        <small className="token-estimate">≈ {Math.ceil(draft.instructions.length / 4)} prompt tokens</small>
      </section>
      <section className="builder-preview">
        <div className="preview-head"><span><i/>Configuration preview</span><small>Live local preview</small></div>
        <div className="preview-canvas">
          <div className="preview-agent"><span className="agent-glyph large"><Sparkles size={30}/></span><span className="eyebrow">{draft.status} agent</span><h1>{draft.name || 'Untitled Agent'}</h1><p>{draft.role || 'Add a role to define this agent.'}</p></div>
          <div className="preview-goal"><span className="eyebrow">Primary objective</span><p>{draft.goal || 'Your agent goal will appear here as you build.'}</p></div>
          <div className="preview-capabilities">{Object.entries(draft.capabilities).map(([key, enabled]) => <span className={enabled ? 'enabled' : ''} key={key}>{enabled ? <Check size={13}/> : <X size={13}/>} {humanize(key)}</span>)}</div>
          <div className="sandbox-note"><Play size={17}/><div><strong>Test with a real task after deployment</strong><p>Sandbox work uses the execution monitor so output, cost, and events remain auditable.</p></div></div>
        </div>
      </section>
      <section className="builder-pane config-pane">
        <div className="builder-section-title"><Zap size={18}/><h2>Capabilities</h2></div>
        {([
          ['webBrowser', 'Web browser', 'Use connected web-capable tools.', Globe2],
          ['codeInterpreter', 'Code interpreter', 'Allow code-oriented execution tools.', Code2],
          ['knowledgeBase', 'Knowledge base', 'Search indexed workspace context.', Database],
        ] as const).map(([key, label, text, Icon]) => <button className={`toggle-card ${draft.capabilities[key] ? 'active' : ''}`} key={key} onClick={() => toggleCapability(key)} type="button"><span><Icon size={18}/></span><div><strong>{label}</strong><small>{text}</small></div><i/></button>)}
        <div className="builder-section-title"><Wrench size={18}/><h2>Connected tools</h2></div>
        {data.tools.filter((tool) => tool.enabled).length ? <div className="tool-checks">{data.tools.filter((tool) => tool.enabled).map((tool) => <label key={tool.id}><input type="checkbox" checked={draft.toolIds.includes(tool.id)} onChange={() => toggleTool(tool.id)}/><span>{tool.name}<small>{tool.kind}</small></span></label>)}</div> : <p className="muted-note">No enabled tools are available. Connect one in Tools Marketplace.</p>}
        <div className="builder-section-title"><Settings size={18}/><h2>Model settings</h2></div>
        <label>Foundation model <small>{data.runtime ? `${data.runtime.provider.replace('-', ' ')} default` : 'Loading runtime default…'}</small><input value={draft.model} maxLength={160} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder={defaultModel || 'Provider model name'}/></label>
        <label>Temperature <strong className="field-value">{draft.temperature}</strong><input type="range" min="0" max="2" step="0.1" value={draft.temperature} onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })}/></label>
        <label>Max output tokens<input type="number" min="128" max="128000" value={draft.maxTokens} onChange={(event) => setDraft({ ...draft, maxTokens: Number(event.target.value) })}/></label>
        <label>Top P <strong className="field-value">{draft.topP}</strong><input type="range" min="0" max="1" step="0.05" value={draft.topP} onChange={(event) => setDraft({ ...draft, topP: Number(event.target.value) })}/></label>
      </section>
    </div>
  </div>;
}
