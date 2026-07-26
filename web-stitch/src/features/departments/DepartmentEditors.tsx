import { AlertTriangle, BriefcaseBusiness, LoaderCircle, UserRoundPlus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import type { Department, OrganizationSnapshot } from '../../api';
import { EmptyState, Status } from '../../components/ui';
import {
  primaryDepartmentId,
  sharedDepartmentIds,
  unassignedDepartmentAgents,
} from './departmentState';

export type DepartmentDraft = {
  name: string;
  description: string;
  displayOrder: number;
  managerAgentId: string | null;
};

export function DepartmentForm({
  snapshot,
  department,
  pending,
  error,
  submitLabel,
  defaultDisplayOrder,
  onSubmit,
  close,
}: {
  snapshot: OrganizationSnapshot;
  department?: Department;
  pending: boolean;
  error: string;
  submitLabel: string;
  defaultDisplayOrder?: number;
  onSubmit: (draft: DepartmentDraft) => void;
  close: () => void;
}) {
  const activeAgents = snapshot.agents.filter((agent) => agent.status === 'active')
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSubmit({
      name: String(form.get('name')).trim(),
      description: String(form.get('description')).trim(),
      displayOrder: Number(form.get('displayOrder')),
      managerAgentId: String(form.get('managerAgentId') || '') || null,
    });
  };
  return <form className="form-grid department-editor-form" onSubmit={submit}>
    <label>Department name<input
      name="name"
      required
      minLength={2}
      maxLength={120}
      defaultValue={department?.name}
      placeholder="Customer Success"
    /></label>
    <label>Description<textarea
      name="description"
      maxLength={2000}
      defaultValue={department?.description}
      placeholder="Responsibility and ownership for this Department"
    /></label>
    <div className="form-columns">
      <label>Display order<input
        name="displayOrder"
        type="number"
        min={0}
        max={1_000_000}
        defaultValue={department?.displayOrder ?? defaultDisplayOrder ?? 0}
      /></label>
      <label>Manager<select name="managerAgentId" defaultValue={department?.managerAgentId ?? ''}>
        <option value="">No manager</option>
        {activeAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} — {agent.role}</option>)}
      </select></label>
    </div>
    <p className="department-form-note">Choosing a manager makes this the agent’s primary Department. Woody asks before moving an existing primary assignment.</p>
    {error && <div className="inline-error" role="alert"><AlertTriangle size={15}/>{error}</div>}
    <div className="form-actions">
      <button type="button" className="button" onClick={close}>Cancel</button>
      <button type="submit" className="button primary" disabled={pending}>{pending ? <LoaderCircle className="spin" size={14}/> : <BriefcaseBusiness size={14}/>} {submitLabel}</button>
    </div>
  </form>;
}

export function MembershipEditor({
  snapshot,
  department,
  pending,
  setPrimary,
  toggleShared,
}: {
  snapshot: OrganizationSnapshot;
  department: Department;
  pending: boolean;
  setPrimary: (agentId: string) => void;
  toggleShared: (agentId: string, assigned: boolean) => void;
}) {
  const agents = snapshot.agents.filter((agent) => agent.status !== 'archived')
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  return <section className="department-membership-editor" aria-labelledby="department-memberships-heading">
    <div><span className="eyebrow">Assignments</span><h3 id="department-memberships-heading">Primary and shared members</h3><p>Each agent has at most one primary Department and may have additional shared assignments.</p></div>
    <div className="department-membership-list">{agents.map((agent) => {
      const primary = primaryDepartmentId(snapshot, agent.id);
      const isPrimary = primary === department.id;
      const isShared = sharedDepartmentIds(snapshot, agent.id).includes(department.id);
      const primaryName = snapshot.departments.find((candidate) => candidate.id === primary)?.name;
      return <article key={agent.id}>
        <span><strong>{agent.name}</strong><small>{agent.role} · {isPrimary ? 'Primary here' : primaryName ? `Primary: ${primaryName}` : 'Unassigned'}</small></span>
        <span>
          <button
            type="button"
            disabled={pending || isPrimary}
            onClick={() => setPrimary(agent.id)}
            aria-label={`Make ${agent.name} primary in ${department.name}`}
          >{isPrimary ? 'Primary' : 'Make primary'}</button>
          <button
            type="button"
            disabled={pending || isPrimary}
            className={isShared ? 'active' : ''}
            aria-pressed={isShared}
            onClick={() => toggleShared(agent.id, isShared)}
            aria-label={`${isShared ? 'Remove' : 'Add'} ${agent.name} ${isShared ? 'from' : 'as shared in'} ${department.name}`}
          >{isShared ? 'Shared' : 'Add shared'}</button>
        </span>
      </article>;
    })}</div>
  </section>;
}

export function ExecutiveEditor({
  snapshot,
  pending,
  error,
  save,
  close,
}: {
  snapshot: OrganizationSnapshot;
  pending: boolean;
  error: string;
  save: (agentId: string | null) => void;
  close: () => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('executiveAgentId') || '');
    save(value || null);
  };
  return <form className="form-grid" onSubmit={submit}>
    <p className="department-form-note">The optional executive appears once between the workspace root and Departments. Selecting one does not change memberships.</p>
    <label>Executive agent<select name="executiveAgentId" defaultValue={snapshot.executiveAgentId ?? ''}>
      <option value="">No executive agent</option>
      {snapshot.agents.filter((agent) => agent.status === 'active').sort((left, right) => left.name.localeCompare(right.name)).map((agent) => <option key={agent.id} value={agent.id}>{agent.name} — {agent.role}</option>)}
    </select></label>
    {error && <div className="inline-error" role="alert"><AlertTriangle size={15}/>{error}</div>}
    <div className="form-actions"><button className="button" type="button" onClick={close}>Cancel</button><button className="button primary" disabled={pending}>Save organization settings</button></div>
  </form>;
}

export function UnassignedDrawer({
  snapshot,
  canEdit,
  pending,
  error,
  assign,
}: {
  snapshot: OrganizationSnapshot;
  canEdit: boolean;
  pending: boolean;
  error: string;
  assign: (agentId: string, departmentId: string) => void;
}) {
  const agents = unassignedDepartmentAgents(snapshot);
  const departments = snapshot.departments.filter((department) => department.status === 'active')
    .sort((left, right) => left.displayOrder - right.displayOrder || left.name.localeCompare(right.name));
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  if (!agents.length) return <EmptyState Icon={UserRoundPlus} title="Everyone has a primary Department" text="Shared assignments remain visible in collaboration view."/>;
  return <div className="department-unassigned-list">
    {error && <div className="inline-error" role="alert"><AlertTriangle size={15}/>{error}</div>}
    {agents.map((agent) => <article key={agent.id}>
    <div><strong>{agent.name}</strong><small>{agent.role} · {agent.status}</small></div>
    {canEdit ? <div>
      <label><span className="sr-only">Primary Department for {agent.name}</span><select
        value={assignments[agent.id] ?? ''}
        onChange={(event) => setAssignments((current) => ({ ...current, [agent.id]: event.target.value }))}
      ><option value="">Choose Department</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
      <button type="button" className="button small" disabled={pending || !assignments[agent.id]} onClick={() => assign(agent.id, assignments[agent.id])}>Assign primary</button>
    </div> : <Status value="unassigned"/>}
    </article>)}</div>;
}
