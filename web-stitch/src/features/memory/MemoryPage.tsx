import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock3, Edit3, LoaderCircle, Pin, ShieldAlert, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, type ManagedMemory, type MemoryManagementFilters, type MemoryScope, type MemoryType } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { EmptyState, Modal, PageHeader, Status } from '../../components/ui';

const types: MemoryType[] = ['preference', 'fact', 'decision', 'project_context', 'workflow_result', 'error_resolution', 'summary', 'hypothesis'];
const scopes: MemoryScope[] = ['workspace', 'agent', 'user'];

type Action =
  | { kind: 'confirm' | 'dispute' | 'expire' | 'delete'; memory: ManagedMemory }
  | { kind: 'pin'; memory: ManagedMemory; importance: number }
  | { kind: 'edit'; memory: ManagedMemory; body: Parameters<typeof api.updateMemory>[1] }
  | { kind: 'supersede'; memory: ManagedMemory; content: string };

export function MemoryPage() {
  const { data: workspace, report, reportError } = useWorkspace();
  const client = useQueryClient();
  const [filters, setFilters] = useState<MemoryManagementFilters>({ expiry: 'any', limit: 50, offset: 0 });
  const [editing, setEditing] = useState<ManagedMemory | null>(null);
  const [superseding, setSuperseding] = useState<ManagedMemory | null>(null);
  const memories = useQuery({ queryKey: ['managed-memories', filters], queryFn: () => api.managedMemories(filters) });
  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      if (action.kind === 'confirm') return api.confirmMemory(action.memory.id);
      if (action.kind === 'dispute') return api.disputeMemory(action.memory.id);
      if (action.kind === 'expire') return api.expireMemory(action.memory.id);
      if (action.kind === 'delete') return api.deleteMemory(action.memory.id);
      if (action.kind === 'pin') return api.updateMemory(action.memory.id, { importance: action.importance });
      if (action.kind === 'edit') return api.updateMemory(action.memory.id, action.body);
      if (action.kind === 'supersede') return api.supersedeMemory(action.memory.id, {
        replacement: {
          type: action.memory.memory_type,
          scope: action.memory.scope,
          agentId: action.memory.agent_id,
          content: action.content,
          importance: action.memory.importance,
        },
      });
      throw new Error('Unsupported memory action');
    },
    onSuccess: async (_result, action) => {
      setEditing(null);
      setSuperseding(null);
      await client.invalidateQueries({ queryKey: ['managed-memories'] });
      report(action.kind === 'delete' ? 'Memory deleted' : action.kind === 'supersede' ? 'Memory superseded with a governed replacement' : 'Memory updated');
    },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Memory action failed'),
  });
  const agentNames = useMemo(() => new Map(workspace.agents.map((agent) => [agent.id, agent.name])), [workspace.agents]);
  const updateFilter = <K extends keyof MemoryManagementFilters>(key: K, value: MemoryManagementFilters[K]) => setFilters((current) => ({ ...current, [key]: value || undefined, offset: 0 }));
  const nextOffset = memories.data?.pagination.nextOffset;
  const previousOffset = Math.max(0, (filters.offset ?? 0) - (filters.limit ?? 50));

  return <div className="memory-page">
    <PageHeader eyebrow="Knowledge" title="Memory management" description="Review governed memory evidence and lifecycle. Disputed, superseded, and expired memories are shown here for review but are not eligible for retrieval."/>
    <section className="panel memory-filter-panel" aria-label="Memory filters">
      <label>Type<select value={filters.type ?? ''} onChange={(event) => updateFilter('type', event.target.value as MemoryType)}><option value="">All types</option>{types.map((type) => <option key={type} value={type}>{label(type)}</option>)}</select></label>
      <label>Scope<select value={filters.scope ?? ''} onChange={(event) => updateFilter('scope', event.target.value as MemoryScope)}><option value="">All scopes</option>{scopes.map((scope) => <option key={scope} value={scope}>{label(scope)}</option>)}</select></label>
      <label>Lifecycle status<select aria-label="Lifecycle status" value={filters.verificationStatus ?? ''} onChange={(event) => updateFilter('verificationStatus', event.target.value as MemoryManagementFilters['verificationStatus'])}><option value="">All lifecycle states</option><option value="user_confirmed">User confirmed</option><option value="agent_inferred">Agent inferred</option><option value="system_generated">System generated</option><option value="unverified">Unverified</option><option value="disputed">Disputed</option><option value="superseded">Superseded</option></select></label>
      <label>Agent<select value={filters.agentId ?? ''} onChange={(event) => updateFilter('agentId', event.target.value)}><option value="">All agents</option>{workspace.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
      <label>Expiry<select aria-label="Expiry" value={filters.expiry ?? 'any'} onChange={(event) => updateFilter('expiry', event.target.value as MemoryManagementFilters['expiry'])}><option value="any">Any expiry</option><option value="active">Active only</option><option value="expired">Expired only</option></select></label>
    </section>
    {memories.error ? <div className="inline-error" role="alert"><AlertTriangle size={16}/>{memories.error instanceof Error ? memories.error.message : 'Could not load governed memories.'}<button className="button" onClick={() => void memories.refetch()}>Try again</button></div> : memories.isLoading ? <div className="panel memory-loading"><LoaderCircle className="spin" size={19}/>Loading governed memories…</div> : !memories.data?.data.length ? <section className="panel"><EmptyState Icon={ShieldAlert} title="No governed memories match these filters" text="Memory may be added by enabled agents or through governed workspace workflows."/></section> : <section className="memory-list" aria-live="polite">
      {memories.data.data.map((memory) => <MemoryCard key={memory.id} memory={memory} agentName={memory.agent_id ? agentNames.get(memory.agent_id) : undefined} pending={mutation.isPending} onAction={(action) => mutation.mutate(action)} edit={() => setEditing(memory)} supersede={() => setSuperseding(memory)}/>) }
    </section>}
    <div className="memory-pagination"><span>{memories.data ? `${memories.data.data.length} memories shown` : ''}</span><div><button className="button" disabled={memories.isLoading || (filters.offset ?? 0) === 0} onClick={() => setFilters((current) => ({ ...current, offset: previousOffset }))}>Previous</button><button className="button" disabled={memories.isLoading || nextOffset === null || nextOffset === undefined} onClick={() => setFilters((current) => ({ ...current, offset: nextOffset ?? 0 }))}>Next</button></div></div>
    {editing && <EditMemoryModal memory={editing} agents={workspace.agents} pending={mutation.isPending} error={mutation.error} close={() => setEditing(null)} save={(body) => mutation.mutate({ kind: 'edit', memory: editing, body })}/>} 
    {superseding && <SupersedeMemoryModal pending={mutation.isPending} error={mutation.error} close={() => setSuperseding(null)} save={(content) => mutation.mutate({ kind: 'supersede', memory: superseding, content })}/>} 
  </div>;
}

function MemoryCard({ memory, agentName, pending, onAction, edit, supersede }: { memory: ManagedMemory; agentName?: string; pending: boolean; onAction: (action: Action) => void; edit: () => void; supersede: () => void }) {
  const expired = Boolean(memory.expires_at && new Date(memory.expires_at) <= new Date());
  const eligible = memory.verification_status !== 'disputed' && memory.verification_status !== 'superseded' && !expired;
  const pinLabel = memory.importance >= .8 ? 'Unpin memory' : 'Pin memory';
  const provenance = memory.metadata.provenance;
  const provenanceRecord = provenance && typeof provenance === 'object' && !Array.isArray(provenance)
    ? provenance as Record<string, unknown>
    : null;
  const provenanceText = provenanceRecord
    ? `${typeof provenanceRecord.type === 'string' ? provenanceRecord.type : 'recorded'}${typeof provenanceRecord.id === 'string' ? ` · ${provenanceRecord.id}` : ''}`
    : 'No additional provenance detail';
  return <article className="panel memory-card"><div className="memory-card-head"><div><span className="eyebrow">{label(memory.memory_type)} · {label(memory.scope)} scope</span><p>{memory.content}</p></div><div className="memory-statuses"><Status value={memory.verification_status}/><Status value={expired ? 'expired' : eligible ? 'retrieval eligible' : 'not eligible'}/></div></div>
    <dl className="memory-facts"><div><dt>Source</dt><dd>{memory.source_type}{memory.source_id ? ` · ${memory.source_id}` : ''}</dd></div><div><dt>Provenance</dt><dd>{provenanceText}</dd></div><div><dt>Agent</dt><dd>{agentName ?? memory.agent_id ?? 'Workspace governed'}</dd></div><div><dt>Expiry</dt><dd>{memory.expires_at ? new Date(memory.expires_at).toLocaleString() : 'No expiry'}</dd></div><div><dt>Accesses</dt><dd>{memory.access_count}{memory.last_accessed_at ? ` · last ${new Date(memory.last_accessed_at).toLocaleString()}` : ''}</dd></div><div><dt>Importance</dt><dd>{Math.round(memory.importance * 100)}%</dd></div><div><dt>Confidence</dt><dd>{Math.round(memory.confidence * 100)}%</dd></div>{memory.superseded_by && <div><dt>Replacement</dt><dd>{memory.superseded_by}</dd></div>}</dl>
    {!eligible && <p className="memory-eligibility"><ShieldAlert size={15}/>Not eligible for retrieval</p>}
    <div className="memory-actions"><button className="button" disabled={pending || memory.verification_status === 'user_confirmed'} onClick={() => onAction({ kind: 'confirm', memory })}><CheckCircle2 size={14}/>Confirm</button><button className="button" disabled={pending || memory.verification_status === 'disputed' || memory.verification_status === 'superseded'} onClick={() => onAction({ kind: 'dispute', memory })}>Dispute</button><button className="button" disabled={pending || memory.verification_status === 'superseded'} onClick={supersede}>Supersede</button><button className="button" disabled={pending || memory.verification_status === 'superseded'} onClick={edit}><Edit3 size={14}/>Edit</button><button className="button" disabled={pending || memory.verification_status === 'superseded'} onClick={() => onAction({ kind: 'pin', memory, importance: memory.importance >= .8 ? .5 : 1 })}><Pin size={14}/>{pinLabel}</button><button className="button" disabled={pending || expired || memory.verification_status === 'superseded'} onClick={() => onAction({ kind: 'expire', memory })}><Clock3 size={14}/>Expire</button><button className="button danger" aria-label="Delete memory" disabled={pending} onClick={() => { if (window.confirm('Delete this memory permanently? This cannot be undone.')) onAction({ kind: 'delete', memory }); }}><Trash2 size={14}/>Delete</button></div>
  </article>;
}

function EditMemoryModal({ memory, agents, pending, error, close, save }: { memory: ManagedMemory; agents: Array<{ id: string; name: string }>; pending: boolean; error: Error | null; close: () => void; save: (body: Parameters<typeof api.updateMemory>[1]) => void }) {
  const [content, setContent] = useState(memory.content); const [importance, setImportance] = useState(String(memory.importance)); const [scope, setScope] = useState(memory.scope); const [agentId, setAgentId] = useState(memory.agent_id ?? ''); const [expiresAt, setExpiresAt] = useState(memory.expires_at ? memory.expires_at.slice(0, 10) : '');
  return <Modal title="Edit governed memory" close={close} wide><form className="form-grid" onSubmit={(event) => { event.preventDefault(); save({ content: content.trim(), importance: Number(importance), scope, agentId: scope === 'workspace' ? null : agentId || null, expiresAt: expiresAt ? new Date(`${expiresAt}T12:00:00.000Z`).toISOString() : null }); }}><label>Memory content<textarea required value={content} onChange={(event) => setContent(event.target.value)} maxLength={50000}/></label><label>Importance<input aria-label="Importance" type="number" min="0" max="1" step="0.1" value={importance} onChange={(event) => setImportance(event.target.value)}/><small>Pin sets importance to 100%.</small></label><label>Scope<select value={scope} onChange={(event) => setScope(event.target.value as MemoryScope)}><option value="workspace">Workspace</option><option value="agent">Agent</option><option value="user">Current user</option></select></label><label>Agent owner<select disabled={scope === 'workspace'} value={agentId} onChange={(event) => setAgentId(event.target.value)} required={scope === 'agent'}><option value="">No agent</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><small>User scope is bound by the server to the signed-in user.</small></label><label>Expiry date<input aria-label="Expiry date" type="date" min={new Date().toISOString().slice(0, 10)} value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)}/><small>Clear to keep this memory until lifecycle action changes it.</small></label>{error && <div className="inline-error" role="alert"><AlertTriangle size={15}/>{error.message}</div>}<div className="form-actions"><button type="button" className="button" onClick={close}>Cancel</button><button className="button primary" disabled={pending || !content.trim()}>{pending ? <LoaderCircle className="spin" size={15}/> : <Edit3 size={15}/>}Save memory</button></div></form></Modal>;
}

function SupersedeMemoryModal({ pending, error, close, save }: { pending: boolean; error: Error | null; close: () => void; save: (content: string) => void }) {
  const [content, setContent] = useState('');
  return <Modal title="Supersede memory" close={close}><form className="form-grid" onSubmit={(event) => { event.preventDefault(); save(content.trim()); }}><p>This creates a governed replacement and marks the current memory superseded. The current memory will no longer be eligible for retrieval.</p><label>Replacement memory<textarea required value={content} onChange={(event) => setContent(event.target.value)} maxLength={50000}/></label>{error && <div className="inline-error" role="alert"><AlertTriangle size={15}/>{error.message}</div>}<div className="form-actions"><button type="button" className="button" onClick={close}>Cancel</button><button className="button danger" disabled={pending || !content.trim()}>{pending ? <LoaderCircle className="spin" size={15}/> : null}Supersede memory</button></div></form></Modal>;
}

function label(value: string) { return value.replaceAll('_', ' '); }
