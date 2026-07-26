# Department Organization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an editable, workspace-scoped Department org chart with one primary Department per agent, optional shared assignments, and no Department-level execution.

**Architecture:** Add an explicit Department schema and transactional service, migrate legacy team data without deleting it, expose a revisioned Department API, and render a hybrid React Flow org chart. Existing agents remain authoritative; the Department domain stores relationships only.

**Tech Stack:** PostgreSQL, Fastify 5, Zod, React 19, TanStack Query, React Flow, TypeScript, Vitest, Testing Library.

## Global Constraints

- Department is organizational only; do not add goals, delegation, or a new runtime.
- Each agent has zero or one primary Department and any number of shared assignments.
- Owners and admins edit; members view.
- Archived Departments retain their history and leave former primary members unassigned.
- Department responses never contain credentials, instructions, hidden memory, or raw tool configuration.
- Existing `/v1/teams` clients remain functional during migration.

---

## File Structure

- Create `src/db/migrations/029_departments.sql`: Department tables, constraints, and legacy backfill.
- Create `src/departments/types.ts`: server-side Department domain types and error codes.
- Create `src/departments/service.ts`: transactions, revision checks, assignments, and archival.
- Create `src/routes/departments.ts`: HTTP validation and response shaping.
- Modify `src/routes/teams.ts`: compatibility adapter backed by Departments.
- Modify `src/solutions/installer.ts`: create Departments for multi-agent solutions.
- Modify `src/server.ts`: register `/v1/departments`.
- Modify `tests/database.integration.test.ts`: database, migration, permission, and compatibility tests.
- Modify `web-stitch/src/api.ts`: browser-safe Department types and methods.
- Create `web-stitch/src/features/departments/DepartmentPage.tsx`: page composition and mutations.
- Create `web-stitch/src/features/departments/DepartmentGraph.tsx`: React Flow graph.
- Create `web-stitch/src/features/departments/departmentLayout.ts`: deterministic nodes and edges.
- Create `web-stitch/src/features/departments/department-layout.test.ts`: pure graph-layout tests.
- Create `web-stitch/src/features/departments/department.css`: responsive graph, drawer, filters, and shared rail.
- Modify `web-stitch/src/App.tsx`: `/departments` route.
- Modify `web-stitch/src/app/navigation.ts`: Department primary-navigation item.
- Modify `web-stitch/src/app/AppShell.tsx`: page title and active state.

### Task 1: Department Schema and Safe Legacy Backfill

**Files:**
- Create: `src/db/migrations/029_departments.sql`
- Test: `tests/database.integration.test.ts`

**Interfaces:**
- Produces tables `departments`, `department_memberships`, `workspace_org_settings`.
- Enforces one active primary membership per agent.
- Preserves legacy tables.

- [ ] **Step 1: Add failing schema and backfill integration tests**

Add a migration-backed test:

```ts
it('migrates legacy teams without inventing a primary department for multi-team agents', async () => {
  const memberships = await query<{
    agent_id: string;
    membership_type: 'primary' | 'shared';
  }>(
    `SELECT agent_id,membership_type
       FROM department_memberships
      WHERE agent_id=$1
      ORDER BY membership_type`,
    [multiTeamAgentId],
  );

  expect(memberships.rows).toHaveLength(2);
  expect(memberships.rows.every((row) => row.membership_type === 'shared')).toBe(true);
});

it('rejects a second primary department', async () => {
  await expect(query(
    `INSERT INTO department_memberships(department_id,agent_id,membership_type)
     VALUES($1,$2,'primary')`,
    [secondDepartmentId, agentWithPrimaryId],
  )).rejects.toMatchObject({ code: '23505' });
});
```

- [ ] **Step 2: Run and verify failure**

```bash
npm test -- tests/database.integration.test.ts
```

Expected: FAIL because Department tables do not exist.

- [ ] **Step 3: Add the migration**

The migration must define:

```sql
CREATE TABLE departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','archived')),
  display_order INTEGER NOT NULL DEFAULT 0,
  manager_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX departments_active_name_idx
  ON departments(workspace_id,lower(name))
  WHERE status='active';

CREATE TABLE department_memberships (
  department_id UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  membership_type TEXT NOT NULL CHECK(membership_type IN ('primary','shared')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(department_id,agent_id)
);

CREATE UNIQUE INDEX department_memberships_one_primary_idx
  ON department_memberships(agent_id)
  WHERE membership_type='primary';

CREATE TABLE workspace_org_settings (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  executive_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Backfill Department IDs from legacy team IDs. For memberships, use:

```sql
WITH membership_counts AS (
  SELECT agent_id,count(*) AS team_count
  FROM team_memberships
  GROUP BY agent_id
)
INSERT INTO department_memberships(department_id,agent_id,membership_type)
SELECT tm.team_id,
       tm.agent_id,
       CASE WHEN mc.team_count=1 THEN 'primary' ELSE 'shared' END
FROM team_memberships tm
JOIN membership_counts mc ON mc.agent_id=tm.agent_id
ON CONFLICT(department_id,agent_id) DO NOTHING;
```

Backfill a Department manager only when a legacy team has exactly one distinct non-null `manager_agent_id`; otherwise leave it unset for explicit review.

- [ ] **Step 4: Run database tests**

```bash
npm test -- tests/database.integration.test.ts
```

Expected: PASS for schema, backfill, and one-primary constraints.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/029_departments.sql tests/database.integration.test.ts
git commit -m "feat: add department organization schema"
```

### Task 2: Transactional Department Service

**Files:**
- Create: `src/departments/types.ts`
- Create: `src/departments/service.ts`
- Test: `tests/database.integration.test.ts`

**Interfaces:**
- Produces `getOrganization(workspaceId): Promise<OrganizationSnapshot>`.
- Produces `createDepartment`, `updateDepartment`, `setMembership`, `removeMembership`, `archiveDepartment`, and `setExecutiveAgent`.
- Every mutation consumes `expectedRevision` and returns the next revision.

- [ ] **Step 1: Add failing service-level integration cases**

```ts
it('moves an agent primary membership atomically', async () => {
  const result = await setMembership({
    workspaceId,
    actorId,
    departmentId: salesId,
    agentId,
    membershipType: 'primary',
    expectedRevision: 1,
  });

  expect(result.revision).toBe(2);
  const primary = await query(
    `SELECT department_id FROM department_memberships
      WHERE agent_id=$1 AND membership_type='primary'`,
    [agentId],
  );
  expect(primary.rows).toEqual([{ department_id: salesId }]);
});

it('rejects stale organization revisions', async () => {
  await expect(updateDepartment({
    workspaceId,
    actorId,
    departmentId,
    expectedRevision: 1,
    name: 'Operations',
  })).rejects.toMatchObject({ code: 'DEPARTMENT_REVISION_CONFLICT' });
});
```

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/database.integration.test.ts
```

- [ ] **Step 3: Define domain types and errors**

```ts
export type MembershipType = 'primary' | 'shared';

export type DepartmentErrorCode =
  | 'DEPARTMENT_NOT_FOUND'
  | 'DEPARTMENT_ARCHIVED'
  | 'DEPARTMENT_NAME_CONFLICT'
  | 'DEPARTMENT_REVISION_CONFLICT'
  | 'DEPARTMENT_AGENT_NOT_FOUND'
  | 'DEPARTMENT_MANAGER_INACTIVE'
  | 'DEPARTMENT_EXECUTIVE_INVALID'
  | 'DEPARTMENT_MEMBERSHIP_NOT_FOUND';

export interface OrganizationSnapshot {
  revision: number;
  executiveAgentId: string | null;
  departments: DepartmentRecord[];
  memberships: DepartmentMembershipRecord[];
}
```

Use one PostgreSQL transaction per mutation:

1. `INSERT ... ON CONFLICT DO NOTHING` for `workspace_org_settings`.
2. Lock settings with `SELECT ... FOR UPDATE`.
3. Compare `expectedRevision`.
4. Validate every resource against `workspace_id`.
5. Apply the mutation.
6. Increment revision.
7. Write an audit row in the same transaction.
8. Commit and return the new snapshot or revision.

Moving a primary membership deletes only the previous `primary` row. It does not remove shared rows.

Selecting a manager validates `agents.status='active'` and atomically gives the manager a primary membership in that Department. The caller must pass `confirmPrimaryMove: true` when the manager currently has another primary Department.

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/database.integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/departments/types.ts src/departments/service.ts tests/database.integration.test.ts
git commit -m "feat: add transactional department service"
```

### Task 3: Department HTTP API and Team Compatibility

**Files:**
- Create: `src/routes/departments.ts`
- Modify: `src/routes/teams.ts`
- Modify: `src/solutions/installer.ts`
- Modify: `src/server.ts`
- Test: `tests/database.integration.test.ts`
- Test: `tests/api-validation.test.ts`

**Interfaces:**
- Produces:
  - `GET /v1/departments`
  - `POST /v1/departments`
  - `PATCH /v1/departments/:id`
  - `DELETE /v1/departments/:id`
  - `PUT /v1/departments/:id/members/:agentId`
  - `DELETE /v1/departments/:id/members/:agentId`
  - `PUT /v1/departments/settings/executive`
- Compatibility `/v1/teams` reads and mutates the same Department service.

- [ ] **Step 1: Add failing API tests**

```ts
it('allows admins to edit departments and members only to read them', async () => {
  const createAsMember = await app.inject({
    method: 'POST',
    url: '/v1/departments',
    headers: memberHeaders,
    payload: { name: 'Operations', expectedRevision: 1 },
  });
  expect(createAsMember.statusCode).toBe(403);

  const readAsMember = await app.inject({
    method: 'GET',
    url: '/v1/departments',
    headers: memberHeaders,
  });
  expect(readAsMember.statusCode).toBe(200);
});

it('returns a conflict with the current revision for stale edits', async () => {
  const response = await app.inject({
    method: 'PATCH',
    url: `/v1/departments/${departmentId}`,
    headers: adminHeaders,
    payload: { name: 'Sales Ops', expectedRevision: 1 },
  });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({
    error: 'DEPARTMENT_REVISION_CONFLICT',
    currentRevision: 2,
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/api-validation.test.ts tests/database.integration.test.ts
```

- [ ] **Step 3: Implement routes and safe responses**

Use Zod schemas with bounded names/descriptions and integer revisions. Shape agent references as:

```ts
type OrganizationAgentSummary = {
  id: string;
  name: string;
  role: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  avatar: Record<string, unknown>;
  activeWorkCount: number;
  apiToolCount: number;
  mcpConnectionCount: number;
};
```

Do not select `instructions`, `memory_config`, tool configuration, credentials, or raw task output.

Register:

```ts
await app.register(departmentRoutes, { prefix: '/v1/departments' });
```

Change `/v1/teams` to map Department snapshots to the legacy response shape. Add a `Deprecation: true` header and `Sunset` only after a removal release is chosen.

Update solution installation to create Departments through the same transaction or SQL schema. Do not dual-write to legacy team tables.

- [ ] **Step 4: Verify APIs**

```bash
npm test -- tests/api-validation.test.ts tests/database.integration.test.ts tests/agent-solution-transaction.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/departments.ts src/routes/teams.ts src/solutions/installer.ts src/server.ts tests/api-validation.test.ts tests/database.integration.test.ts tests/agent-solution-transaction.test.ts
git commit -m "feat: expose department organization API"
```

### Task 4: Browser-Safe Client and Deterministic Graph Layout

**Files:**
- Modify: `web-stitch/src/api.ts`
- Create: `web-stitch/src/features/departments/departmentLayout.ts`
- Create: `web-stitch/src/features/departments/department-layout.test.ts`

**Interfaces:**
- Produces `api.departments`, `api.createDepartment`, `api.updateDepartment`, membership methods, and `api.setExecutiveAgent`.
- Produces `buildDepartmentGraph(snapshot, options): { nodes, edges }`.

- [ ] **Step 1: Write failing pure layout tests**

```ts
it('renders each agent once in org view and places shared agents in the shared rail', () => {
  const graph = buildDepartmentGraph(snapshot, { view: 'org' });
  expect(graph.nodes.filter((node) => node.data.agentId === sharedAgentId)).toHaveLength(1);
  expect(graph.nodes.find((node) => node.data.agentId === sharedAgentId)?.data.kind).toBe('shared-agent');
});

it('shows shared edges only in collaboration view or focus mode', () => {
  expect(buildDepartmentGraph(snapshot, { view: 'org' }).edges.some((edge) => edge.data?.kind === 'shared')).toBe(false);
  expect(buildDepartmentGraph(snapshot, { view: 'collaboration' }).edges.some((edge) => edge.data?.kind === 'shared')).toBe(true);
});
```

- [ ] **Step 2: Verify failure**

```bash
npm --prefix web-stitch exec vitest run src/features/departments/department-layout.test.ts
```

- [ ] **Step 3: Add types, client methods, and pure layout**

Add browser-safe types that match the server response exactly. Use deterministic sort keys:

```text
Department: displayOrder, then name, then id
Agent: manager first, then role, then name, then id
Shared rail: name, then id
```

Use solid edges for the primary hierarchy and dashed edges for shared collaboration. Do not persist layout coordinates in phase one; derive them from organization structure and provide client-side reset.

- [ ] **Step 4: Verify**

```bash
npm --prefix web-stitch exec vitest run src/features/departments/department-layout.test.ts
npm --prefix web-stitch run build
```

- [ ] **Step 5: Commit**

```bash
git add web-stitch/src/api.ts web-stitch/src/features/departments/departmentLayout.ts web-stitch/src/features/departments/department-layout.test.ts
git commit -m "feat: add department graph contracts"
```

### Task 5: Department Hybrid Org-Chart UI

**Files:**
- Create: `web-stitch/src/features/departments/DepartmentPage.tsx`
- Create: `web-stitch/src/features/departments/DepartmentGraph.tsx`
- Create: `web-stitch/src/features/departments/department.css`
- Modify: `web-stitch/src/App.tsx`
- Modify: `web-stitch/src/app/navigation.ts`
- Modify: `web-stitch/src/app/AppShell.tsx`
- Test: `web-stitch/src/features/departments/department-layout.test.ts`

**Interfaces:**
- Consumes the Department API and pure layout.
- Produces `/departments`.

- [ ] **Step 1: Add failing page-state tests**

```tsx
it('keeps org view as the default and collaboration view explicit', () => {
  expect(initialDepartmentView()).toBe('org');
  expect(nextDepartmentView('org', 'toggle-collaboration')).toBe('collaboration');
});

it('requires confirmation before moving a primary membership', () => {
  expect(requiresPrimaryMoveConfirmation({
    currentPrimaryDepartmentId: 'marketing',
    nextDepartmentId: 'sales',
  })).toBe(true);
});
```

- [ ] **Step 2: Verify failure**

```bash
npm --prefix web-stitch exec vitest run src/features/departments/department-layout.test.ts
```

- [ ] **Step 3: Implement the page**

The page includes:

- Org/Collaboration segmented control.
- Department, role, status, active-work, MCP-access, and API-Tool-access filters.
- Unassigned-agent drawer.
- Create/edit/archive Department dialogs.
- Executive-agent selector.
- Manager selector.
- Primary/shared membership editor.
- Focus mode.
- Reset layout.
- Accessible list fallback for keyboard and small-screen users.

At laptop widths, open editors in a closable side drawer. At mobile widths, use a full-height drawer and default to the accessible hierarchical list rather than forcing a miniature graph.

Add Department to primary navigation only when the `/departments` route ships.

- [ ] **Step 4: Verify frontend**

```bash
npm --prefix web-stitch exec vitest run src/features/departments/department-layout.test.ts
npm --prefix web-stitch run build
npm --prefix web-stitch run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-stitch/src/features/departments web-stitch/src/App.tsx web-stitch/src/app/navigation.ts web-stitch/src/app/AppShell.tsx
git commit -m "feat: add hybrid Department org chart"
```

### Task 6: Department Acceptance Gate

**Files:**
- Verify only. Return to the owning task before changing a file when a check fails.

- [ ] **Step 1: Run all focused tests**

```bash
npm test -- tests/api-validation.test.ts tests/database.integration.test.ts tests/agent-solution-transaction.test.ts
npm --prefix web-stitch exec vitest run src/features/departments
```

- [ ] **Step 2: Run builds and lint**

```bash
npm run build
npm --prefix web-stitch run build
npm --prefix web-stitch run lint
```

- [ ] **Step 3: Perform live acceptance**

Verify:

```text
Workspace root is always visible
Executive agent is optional
One agent cannot receive two primary Departments
Multi-team legacy agents are shared/unassigned after migration
Shared links are hidden in default org view
Focus mode hides unrelated relationships
Members cannot mutate organization structure
Archived Departments preserve agents
Graph responses contain no secrets, instructions, memory, or raw tool config
Mobile has a usable hierarchical-list fallback
```
