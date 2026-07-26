import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Filter,
  LayoutList,
  LoaderCircle,
  Network,
  Plus,
  RefreshCw,
  Settings2,
  Share2,
  SlidersHorizontal,
  Trash2,
  UserRoundPlus,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, type Department, type OrganizationSnapshot } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { EmptyState, Modal, PageHeader, Status } from '../../components/ui';
import { DepartmentDrawer } from './DepartmentDrawer';
import {
  DepartmentForm,
  ExecutiveEditor,
  MembershipEditor,
  UnassignedDrawer,
  type DepartmentDraft,
} from './DepartmentEditors';
import { DepartmentGraph, DepartmentHierarchyList } from './DepartmentGraph';
import {
  canEditDepartmentStructure,
  departmentMutationFailure,
  emptyDepartmentFilters,
  filteredDepartmentAgentIds,
  initialDepartmentCanvasMode,
  initialDepartmentView,
  nextDepartmentCanvasMode,
  nextDepartmentView,
  primaryDepartmentId,
  requiresPrimaryMoveConfirmation,
  unassignedDepartmentAgents,
  type DepartmentCanvasMode,
  type DepartmentFilters,
  type DepartmentView,
} from './departmentState';
import './department.css';

type DrawerState =
  | { kind: 'create' }
  | { kind: 'department'; departmentId: string }
  | { kind: 'settings' }
  | { kind: 'unassigned' }
  | null;

type PendingMove =
  | { kind: 'membership'; agentId: string; departmentId: string }
  | {
    kind: 'save';
    departmentId: string | null;
    draft: DepartmentDraft;
    managerAgentId: string;
  };

function smallScreenDefault() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 720px)').matches;
}

function focusLabel(snapshot: OrganizationSnapshot, focusId: string | null) {
  if (!focusId) return '';
  if (focusId === 'workspace') return 'Workspace';
  if (focusId.startsWith('department:')) {
    return snapshot.departments.find((department) => (
      department.id === focusId.slice('department:'.length)
    ))?.name ?? 'Department';
  }
  if (focusId.startsWith('agent:')) {
    return snapshot.agents.find((agent) => (
      agent.id === focusId.slice('agent:'.length)
    ))?.name ?? 'Agent';
  }
  return 'Organization';
}

export function DepartmentPage() {
  const { session, report } = useWorkspace();
  const queryClient = useQueryClient();
  const organization = useQuery({
    queryKey: ['departments'],
    queryFn: api.departments,
    refetchOnWindowFocus: true,
  });
  const [view, setView] = useState<DepartmentView>(initialDepartmentView);
  const [canvasMode, setCanvasMode] = useState<DepartmentCanvasMode>(() => (
    initialDepartmentCanvasMode(smallScreenDefault())
  ));
  const [filters, setFilters] = useState<DepartmentFilters>(emptyDepartmentFilters);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Department | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const [mutationError, setMutationError] = useState('');
  const canEdit = canEditDepartmentStructure(session.workspace.role);
  const snapshot = organization.data;
  const visibleAgentIds = useMemo(() => snapshot
    ? filteredDepartmentAgentIds(snapshot, filters)
    : new Set<string>(), [snapshot, filters]);

  const openDrawer = (next: Exclude<DrawerState, null>) => {
    setMutationError('');
    setDrawer(next);
  };
  const closeDrawer = () => {
    setDrawer(null);
    setMutationError('');
  };
  const execute = async (
    operation: () => Promise<unknown>,
    successMessage: string,
    onSuccess?: () => void,
  ) => {
    if (!canEdit) {
      setMutationError('Your workspace role does not allow Department changes.');
      return;
    }
    setMutationPending(true);
    setMutationError('');
    try {
      await operation();
      await queryClient.invalidateQueries({ queryKey: ['departments'] });
      report(successMessage);
      onSuccess?.();
    } catch (cause) {
      const failure = departmentMutationFailure(cause);
      setMutationError(failure.message);
      if (failure.refresh) await organization.refetch();
    } finally {
      setMutationPending(false);
    }
  };

  if (organization.isLoading) {
    return <div className="department-page department-loading" role="status">
      <LoaderCircle className="spin" size={22}/>Loading organization…
    </div>;
  }
  if (!snapshot || organization.error) {
    return <div className="department-page">
      <EmptyState
        Icon={AlertTriangle}
        title="Could not load the organization"
        text={organization.error instanceof Error ? organization.error.message : 'Refresh to try again.'}
        action={<button className="button" type="button" onClick={() => void organization.refetch()}><RefreshCw size={15}/>Refresh</button>}
      />
    </div>;
  }

  const activeDepartments = snapshot.departments.filter((department) => (
    department.status === 'active'
  ));
  const unassigned = unassignedDepartmentAgents(snapshot);
  const roles = [...new Set(snapshot.agents.map((agent) => agent.role))].sort();
  const selectedDepartment = drawer?.kind === 'department'
    ? snapshot.departments.find((department) => department.id === drawer.departmentId)
    : undefined;
  const saveDepartment = async (
    departmentId: string | null,
    draft: DepartmentDraft,
    confirmPrimaryMove = false,
  ) => {
    const managerPrimary = draft.managerAgentId
      ? primaryDepartmentId(snapshot, draft.managerAgentId)
      : null;
    if (
      draft.managerAgentId
      && requiresPrimaryMoveConfirmation({
        currentPrimaryDepartmentId: managerPrimary,
        nextDepartmentId: departmentId ?? '__new_department__',
      })
      && !confirmPrimaryMove
    ) {
      setPendingMove({
        kind: 'save',
        departmentId,
        draft,
        managerAgentId: draft.managerAgentId,
      });
      return;
    }
    await execute(
      () => departmentId
        ? api.updateDepartment(departmentId, {
          ...draft,
          confirmPrimaryMove,
          expectedRevision: snapshot.revision,
        })
        : api.createDepartment({
          ...draft,
          confirmPrimaryMove,
          expectedRevision: snapshot.revision,
        }),
      departmentId ? `${draft.name} updated` : `${draft.name} created`,
      closeDrawer,
    );
  };
  const setPrimary = async (agentId: string, departmentId: string, confirmed = false) => {
    const currentPrimaryDepartmentId = primaryDepartmentId(snapshot, agentId);
    if (
      !confirmed
      && requiresPrimaryMoveConfirmation({
        currentPrimaryDepartmentId,
        nextDepartmentId: departmentId,
      })
    ) {
      setPendingMove({ kind: 'membership', agentId, departmentId });
      return;
    }
    await execute(
      () => api.setDepartmentMembership(departmentId, agentId, {
        membershipType: 'primary',
        expectedRevision: snapshot.revision,
      }),
      'Primary Department updated',
    );
  };
  const confirmMove = async () => {
    const pending = pendingMove;
    setPendingMove(null);
    if (!pending) return;
    if (pending.kind === 'membership') {
      await setPrimary(pending.agentId, pending.departmentId, true);
      return;
    }
    await saveDepartment(pending.departmentId, pending.draft, true);
  };
  const pendingDepartmentName = pendingMove
    ? pendingMove.kind === 'membership'
      ? snapshot.departments.find((department) => department.id === pendingMove.departmentId)?.name
      : pendingMove.departmentId
        ? snapshot.departments.find((department) => department.id === pendingMove.departmentId)?.name
        : pendingMove.draft.name
    : '';

  return <div className="department-page">
    <PageHeader
      eyebrow="Organization"
      title="Department organization"
      description="Map responsibility, ownership, and collaboration across your agent workforce. Department does not initiate work or delegation."
      actions={<div className="department-header-actions">
        {!canEdit && <span className="department-readonly"><Status value="viewer"/>Read-only organization</span>}
        <button className="button" type="button" onClick={() => openDrawer({ kind: 'unassigned' })}>
          <UserRoundPlus size={15}/>Unassigned <span>{unassigned.length}</span>
        </button>
        {canEdit && <button className="button" type="button" onClick={() => openDrawer({ kind: 'settings' })}>
          <Settings2 size={15}/>Organization settings
        </button>}
        {canEdit && <button className="button primary" type="button" onClick={() => openDrawer({ kind: 'create' })}>
          <Plus size={15}/>Create Department
        </button>}
      </div>}
    />

    <section className="department-toolbar panel" aria-label="Department view controls">
      <div className="department-segments" role="group" aria-label="Organization view">
        <button
          type="button"
          className={view === 'org' ? 'active' : ''}
          aria-pressed={view === 'org'}
          onClick={() => setView((current) => nextDepartmentView(current, 'show-org'))}
        >Organization</button>
        <button
          type="button"
          className={view === 'collaboration' ? 'active' : ''}
          aria-pressed={view === 'collaboration'}
          onClick={() => setView((current) => nextDepartmentView(current, 'show-collaboration'))}
        ><Share2 size={14}/>Collaboration</button>
      </div>
      <div className="department-segments" role="group" aria-label="Organization presentation">
        <button
          type="button"
          className={canvasMode === 'graph' ? 'active' : ''}
          aria-pressed={canvasMode === 'graph'}
          onClick={() => setCanvasMode((current) => nextDepartmentCanvasMode(current, 'show-graph'))}
        ><Network size={14}/>Graph</button>
        <button
          type="button"
          className={canvasMode === 'list' ? 'active' : ''}
          aria-pressed={canvasMode === 'list'}
          onClick={() => setCanvasMode((current) => nextDepartmentCanvasMode(current, 'show-list'))}
        ><LayoutList size={14}/>Accessible list</button>
      </div>
      <span className="department-toolbar-spacer"/>
      <button className="button small" type="button" onClick={() => setResetKey((current) => current + 1)}>
        <RefreshCw size={14}/>Reset layout
      </button>
    </section>

    <details className="department-filters panel">
      <summary><Filter size={15}/>Filters <span>{visibleAgentIds.size} of {snapshot.agents.length} agents</span></summary>
      <div className="department-filter-grid">
        <label>Department<select
          value={filters.departmentId}
          onChange={(event) => setFilters((current) => ({ ...current, departmentId: event.target.value }))}
        ><option value="all">All Departments</option>{activeDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
        <label>Role<select
          value={filters.role}
          onChange={(event) => setFilters((current) => ({ ...current, role: event.target.value }))}
        ><option value="all">All roles</option>{roles.map((role) => <option key={role}>{role}</option>)}</select></label>
        <label>Status<select
          value={filters.status}
          onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
        ><option value="all">All statuses</option><option value="active">Active</option><option value="paused">Paused</option><option value="draft">Draft</option><option value="archived">Archived</option></select></label>
        <BinarySelect label="Active work" value={filters.activeWork} change={(activeWork) => setFilters((current) => ({ ...current, activeWork }))}/>
        <BinarySelect label="MCP access" value={filters.mcpAccess} change={(mcpAccess) => setFilters((current) => ({ ...current, mcpAccess }))}/>
        <BinarySelect label="API Tool access" value={filters.apiToolAccess} change={(apiToolAccess) => setFilters((current) => ({ ...current, apiToolAccess }))}/>
      </div>
    </details>

    {focusId && <div className="department-focus panel" role="status">
      <SlidersHorizontal size={15}/><span>Focus mode: <strong>{focusLabel(snapshot, focusId)}</strong></span>
      <button type="button" onClick={() => setFocusId(null)}>Show full organization</button>
    </div>}

    <section className={`department-organization-panel panel ${canvasMode}`}>
      {canvasMode === 'graph' ? <DepartmentGraph
        snapshot={snapshot}
        workspaceName={session.workspace.name}
        view={view}
        focusId={focusId}
        visibleAgentIds={visibleAgentIds}
        departmentId={filters.departmentId}
        resetKey={resetKey}
        onFocus={setFocusId}
        onEditDepartment={(departmentId) => openDrawer({ kind: 'department', departmentId })}
        canEdit={canEdit}
      /> : <DepartmentHierarchyList
        snapshot={snapshot}
        workspaceName={session.workspace.name}
        view={view}
        focusId={focusId}
        visibleAgentIds={visibleAgentIds}
        departmentId={filters.departmentId}
        onFocus={setFocusId}
        onEditDepartment={(departmentId) => openDrawer({ kind: 'department', departmentId })}
        canEdit={canEdit}
      />}
    </section>

    {drawer?.kind === 'create' && <DepartmentDrawer title="Create Department" eyebrow="Organization editor" close={closeDrawer}>
      <DepartmentForm
        snapshot={snapshot}
        pending={mutationPending}
        error={mutationError}
        submitLabel="Create Department"
        defaultDisplayOrder={(Math.max(0, ...snapshot.departments.map((department) => department.displayOrder)) + 10)}
        onSubmit={(draft) => void saveDepartment(null, draft)}
        close={closeDrawer}
      />
    </DepartmentDrawer>}
    {drawer?.kind === 'department' && selectedDepartment && <DepartmentDrawer title={`Edit ${selectedDepartment.name}`} eyebrow="Department editor" close={closeDrawer}>
      <DepartmentForm
        snapshot={snapshot}
        department={selectedDepartment}
        pending={mutationPending}
        error={mutationError}
        submitLabel="Save Department"
        onSubmit={(draft) => void saveDepartment(selectedDepartment.id, draft)}
        close={closeDrawer}
      />
      <MembershipEditor
        snapshot={snapshot}
        department={selectedDepartment}
        pending={mutationPending}
        setPrimary={(agentId) => void setPrimary(agentId, selectedDepartment.id)}
        toggleShared={(agentId, assigned) => void execute(
          () => assigned
            ? api.removeDepartmentMembership(selectedDepartment.id, agentId, snapshot.revision)
            : api.setDepartmentMembership(selectedDepartment.id, agentId, {
              membershipType: 'shared',
              expectedRevision: snapshot.revision,
            }),
          assigned ? 'Shared assignment removed' : 'Shared assignment added',
        )}
      />
      <div className="department-danger-zone">
        <span><strong>Archive Department</strong><small>Primary members become unassigned. Agents are preserved; assignments to this Department are removed.</small></span>
        <button type="button" className="button danger" disabled={mutationPending} onClick={() => setArchiveTarget(selectedDepartment)}><Trash2 size={14}/>Archive</button>
      </div>
    </DepartmentDrawer>}
    {drawer?.kind === 'settings' && <DepartmentDrawer title="Organization settings" eyebrow="Workspace hierarchy" close={closeDrawer}>
      <ExecutiveEditor
        snapshot={snapshot}
        pending={mutationPending}
        error={mutationError}
        close={closeDrawer}
        save={(agentId) => void execute(
          () => api.setExecutiveAgent(agentId, snapshot.revision),
          agentId ? 'Executive agent updated' : 'Executive agent removed',
          closeDrawer,
        )}
      />
    </DepartmentDrawer>}
    {drawer?.kind === 'unassigned' && <DepartmentDrawer title="Unassigned agents" eyebrow="Organization coverage" close={closeDrawer}>
      <UnassignedDrawer
        snapshot={snapshot}
        canEdit={canEdit}
        pending={mutationPending}
        assign={(agentId, departmentId) => void setPrimary(agentId, departmentId)}
      />
    </DepartmentDrawer>}

    {pendingMove && <Modal title="Move primary Department" close={() => setPendingMove(null)}>
      <div className="department-confirmation">
        <AlertTriangle size={20}/>
        <div><p>This agent already has a primary Department. Moving it changes its canonical place in the organization.</p><p>Shared assignments are not changed.</p></div>
      </div>
      <div className="form-actions">
        <button type="button" className="button" onClick={() => setPendingMove(null)}>Cancel</button>
        <button type="button" className="button primary" disabled={mutationPending} onClick={() => void confirmMove()}>
          Move to {pendingDepartmentName}
        </button>
      </div>
    </Modal>}
    {archiveTarget && <Modal title={`Archive ${archiveTarget.name}`} close={() => setArchiveTarget(null)}>
      <div className="department-confirmation">
        <Trash2 size={20}/><p>Archive this Department? Its primary members will become unassigned. No agents will be removed.</p>
      </div>
      <div className="form-actions">
        <button type="button" className="button" onClick={() => setArchiveTarget(null)}>Cancel</button>
        <button type="button" className="button danger" disabled={mutationPending} onClick={() => void execute(
          () => api.archiveDepartment(archiveTarget.id, snapshot.revision),
          `${archiveTarget.name} archived`,
          () => {
            setArchiveTarget(null);
            closeDrawer();
          },
        )}>Archive Department</button>
      </div>
    </Modal>}
  </div>;
}

function BinarySelect({
  label,
  value,
  change,
}: {
  label: string;
  value: DepartmentFilters['activeWork'];
  change: (value: DepartmentFilters['activeWork']) => void;
}) {
  return <label>{label}<select value={value} onChange={(event) => change(event.target.value as DepartmentFilters['activeWork'])}>
    <option value="any">Any</option><option value="yes">Has access/work</option><option value="no">No access/work</option>
  </select></label>;
}
