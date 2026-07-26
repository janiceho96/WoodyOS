# Quality, Memory, and Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist trustworthy quality history, govern memory throughout its lifecycle, and add safe workflow dry-run and regression evaluation using the version and trace identities from the runtime-trust plan.

**Architecture:** Add normalized quality, memory-governance, regression-case, and evaluation-run records. Keep workflow state as the current execution view, but persist quality entries as immutable domain history. Keep Knowledge and memory separate: Knowledge is retrieved evidence; memory is scoped operational context with provenance and validity.

**Tech Stack:** PostgreSQL, Fastify 5, TypeScript, Zod, React 19, TanStack Query, Vitest.

## Global Constraints

- Requires the agent versions, execution manifests, and trace context from the Runtime Trust Foundations plan.
- A grade must identify the exact candidate task and output version it evaluated.
- Agent-inferred memory never becomes user-confirmed automatically.
- Expired, disputed, or superseded memory is excluded from normal retrieval.
- Dry-run performs no model, MCP, API Tool, browser, or external file action.
- Regression evaluation uses explicit fixtures for tool/action nodes and never falls back to live external writes.

---

## File Structure

- Create `src/db/migrations/032_quality_memory_evaluation.sql`.
- Create `src/quality/history.ts`: immutable quality-entry persistence.
- Modify `src/workflows/adapters/logic.ts`: append durable quality entries.
- Modify `src/workflows/adapters/agent.ts`: expose candidate task and output-version identities.
- Modify `src/outputs/service.ts`: return stable version identities.
- Create `src/memories/types.ts`: governed memory model.
- Create `src/memories/service.ts`: lifecycle mutations and retrieval.
- Create `src/memories/ranking.ts`: deterministic ranking inputs.
- Modify `src/routes/memories.ts`: governed API and safe response.
- Modify `src/lib/agent-runtime.ts`: retrieve eligible scoped memories.
- Create `src/workflows/dry-run.ts`: static execution preview.
- Create `src/workflows/contracts.ts`: typed node-port and binding compatibility.
- Create `src/workflows/evaluation.ts`: fixture-based regression runner.
- Create `src/runtime/replay.ts`: redacted trace-ordered execution replay.
- Modify `src/routes/workflows.ts`: dry-run, regression-case, evaluation, and replay endpoints.
- Modify `web-stitch/src/api.ts`: quality, memory, evaluation, and replay contracts.
- Modify `web-stitch/src/features/workflows/WorkflowsPage.tsx`: dry-run and regression controls.
- Modify `web-stitch/src/features/execution/ExecutionPage.tsx`: quality and replay timeline.
- Create `web-stitch/src/features/memory/MemoryPage.tsx`: memory explorer and lifecycle actions.
- Modify `web-stitch/src/app/AppShell.tsx` and `web-stitch/src/App.tsx`: expose Memory under Knowledge or Settings, not as another primary item.
- Create `tests/quality-history.test.ts`.
- Create `tests/memory-governance.test.ts`.
- Create `tests/workflow-evaluation.test.ts`.
- Modify `tests/workflows.test.ts`, `tests/agent-runtime.test.ts`, and `tests/database.integration.test.ts`.

### Task 1: Immutable Output-Linked Quality History

**Files:**
- Create: `src/db/migrations/032_quality_memory_evaluation.sql`
- Create: `src/quality/history.ts`
- Create: `tests/quality-history.test.ts`
- Modify: `src/workflows/adapters/logic.ts`
- Modify: `src/workflows/adapters/agent.ts`
- Modify: `src/outputs/service.ts`

**Interfaces:**
- Produces `appendQualityHistoryEntry`.
- Produces `listQualityHistory(workspaceId, workflowRunId)`.
- Quality-loop state stores entry IDs and a current summary, not the only authoritative history.

- [ ] **Step 1: Write failing quality-history tests**

```ts
it('links every grade to an exact candidate and grader identity', async () => {
  const entry = await appendQualityHistoryEntry({
    workspaceId,
    workflowRunId,
    sequence: 1,
    automatedRevision: 1,
    manualRevision: 0,
    candidateTaskId,
    outputDocumentVersionId,
    candidateHash,
    graderTaskId,
    graderAgentVersionId,
    modelIdentity: 'openai:gpt-5',
    result: graderResult,
    exitReason: null,
  });

  expect(entry.outputDocumentVersionId).toBe(outputDocumentVersionId);
  expect(entry.graderAgentVersionId).toBe(graderAgentVersionId);
});

it('does not overwrite an earlier grade', async () => {
  await expect(updateQualityEntryForTest(entryId, changedResult))
    .rejects.toMatchObject({ code: 'QUALITY_HISTORY_IMMUTABLE' });
});
```

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/quality-history.test.ts
```

- [ ] **Step 3: Add schema**

```sql
CREATE TABLE quality_history_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  automated_revision INTEGER NOT NULL DEFAULT 0 CHECK(automated_revision >= 0),
  manual_revision INTEGER NOT NULL DEFAULT 0 CHECK(manual_revision >= 0),
  candidate_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  output_document_version_id UUID NOT NULL REFERENCES output_document_versions(id) ON DELETE RESTRICT,
  candidate_hash TEXT NOT NULL CHECK(length(candidate_hash)=64),
  grader_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  grader_agent_version_id UUID NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
  model_identity TEXT NOT NULL,
  result JSONB NOT NULL,
  exit_reason TEXT,
  trace_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workflow_run_id,sequence)
);
```

Do not add update or delete application methods. Database ownership should deny ordinary application-role updates after insert where deployment roles support it.

- [ ] **Step 4: Persist from the quality loop**

The agent adapter returns:

```ts
type AgentNodeExecutionIdentity = {
  taskId: string;
  agentVersionId: string;
  outputDocumentVersionId: string;
  modelIdentity: string;
  output: unknown;
};
```

When the quality loop consumes a grader verdict, call `initializeTaskOutputDocument` for the candidate task if it has no output document, use its exact current version, and then insert the durable history row before advancing the loop. If the candidate cannot produce versionable text, fail with the non-retryable `QUALITY_CANDIDATE_VERSION_REQUIRED`. Add the inserted entry ID to materialized workflow state for convenient display.

- [ ] **Step 5: Verify**

```bash
npm test -- tests/quality-history.test.ts tests/workflows.test.ts tests/editable-output.test.ts
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/032_quality_memory_evaluation.sql src/quality/history.ts src/workflows/adapters/logic.ts src/workflows/adapters/agent.ts src/outputs/service.ts tests/quality-history.test.ts
git commit -m "feat: persist output-linked quality history"
```

### Task 2: Governed Memory Schema and Lifecycle

**Files:**
- Create: `src/memories/types.ts`
- Create: `src/memories/service.ts`
- Create: `tests/memory-governance.test.ts`
- Modify: `src/db/migrations/032_quality_memory_evaluation.sql`
- Modify: `src/routes/memories.ts`

**Interfaces:**
- Produces `createMemory`, `confirmMemory`, `disputeMemory`, `supersedeMemory`, `expireMemory`, and `deleteMemory`.
- Produces safe memory-list filters.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it('keeps an agent inference unverified until a user confirms it', async () => {
  const memory = await createMemory({
    workspaceId,
    agentId,
    type: 'hypothesis',
    content: 'The customer prefers weekly reports',
    source: { type: 'agent', id: agentId },
    verificationStatus: 'agent_inferred',
  });
  expect(memory.verificationStatus).toBe('agent_inferred');

  const confirmed = await confirmMemory({ workspaceId, memoryId: memory.id, actorId });
  expect(confirmed.verificationStatus).toBe('user_confirmed');
});

it('excludes expired, disputed, and superseded memory', async () => {
  const eligible = await listEligibleMemories({ workspaceId, agentId, now });
  expect(eligible.map((item) => item.id)).not.toEqual(
    expect.arrayContaining([expiredId, disputedId, supersededId]),
  );
});
```

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/memory-governance.test.ts
```

- [ ] **Step 3: Extend memory schema**

Add explicit columns:

```sql
ALTER TABLE memories
  ADD COLUMN memory_type TEXT,
  ADD COLUMN scope TEXT,
  ADD COLUMN source_type TEXT,
  ADD COLUMN source_id TEXT,
  ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0 AND 1),
  ADD COLUMN verification_status TEXT,
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD COLUMN superseded_by UUID REFERENCES memories(id) ON DELETE SET NULL,
  ADD COLUMN last_accessed_at TIMESTAMPTZ,
  ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0 CHECK(access_count >= 0);
```

Allowed values:

```ts
export type MemoryType =
  | 'preference'
  | 'fact'
  | 'decision'
  | 'project_context'
  | 'workflow_result'
  | 'error_resolution'
  | 'summary'
  | 'hypothesis';

export type MemoryScope = 'workspace' | 'agent' | 'user';

export type VerificationStatus =
  | 'user_confirmed'
  | 'agent_inferred'
  | 'system_generated'
  | 'unverified'
  | 'disputed'
  | 'superseded';
```

Backfill old `kind` values conservatively:

```text
user → preference / user_confirmed
knowledge → fact / unverified
conversation → summary / unverified
```

Keep `kind` during one compatibility release, then remove it in a later migration.

- [ ] **Step 4: Implement guarded mutations**

Only a user action may set `user_confirmed`. Superseding memory is transactional: insert or identify the replacement, mark the old record `superseded`, and set `superseded_by`.

Memory list responses include provenance and lifecycle fields but never embedding vectors.

- [ ] **Step 5: Verify**

```bash
npm test -- tests/memory-governance.test.ts tests/api-validation.test.ts tests/database.integration.test.ts
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/032_quality_memory_evaluation.sql src/memories/types.ts src/memories/service.ts src/routes/memories.ts tests/memory-governance.test.ts
git commit -m "feat: govern memory provenance and lifecycle"
```

### Task 3: Trust-Aware Memory Retrieval

**Files:**
- Create: `src/memories/ranking.ts`
- Modify: `src/memories/service.ts`
- Modify: `src/lib/agent-runtime.ts`
- Modify: `tests/memory-governance.test.ts`
- Modify: `tests/agent-runtime.test.ts`

**Interfaces:**
- Produces `rankMemoryCandidate`.
- Produces `retrieveAgentMemories`.

- [ ] **Step 1: Write failing ranking tests**

```ts
it('ranks a confirmed scoped fact above a similar disputed memory', () => {
  expect(rankMemoryCandidate(confirmedFact, context))
    .toBeGreaterThan(rankMemoryCandidate(disputedSimilarMemory, context));
});

it('does not retrieve memory outside the requesting scope', async () => {
  const results = await retrieveAgentMemories({
    workspaceId,
    agentId,
    userId,
    query: 'CRM preference',
    limit: 8,
  });
  expect(results.some((item) => item.id === otherAgentPrivateMemoryId)).toBe(false);
});
```

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/memory-governance.test.ts tests/agent-runtime.test.ts
```

- [ ] **Step 3: Implement ranking**

Normalize each signal to `0..1` and use:

```ts
score =
  semanticRelevance * 0.40 +
  scopeMatch * 0.20 +
  sourceAuthority * 0.15 +
  confidence * 0.10 +
  importance * 0.10 +
  recency * 0.05;
```

Eligibility is a hard filter before scoring:

- Not expired.
- Not disputed.
- Not superseded.
- Scope allows the requesting agent/user.
- Verification is not `agent_inferred` when the caller requires confirmed facts.

Update `last_accessed_at` and increment `access_count` only for memories actually included in the final prompt.

- [ ] **Step 4: Verify**

```bash
npm test -- tests/memory-governance.test.ts tests/agent-runtime.test.ts
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/memories/ranking.ts src/memories/service.ts src/lib/agent-runtime.ts tests/memory-governance.test.ts tests/agent-runtime.test.ts
git commit -m "feat: rank eligible memory by trust and scope"
```

### Task 4: No-Side-Effect Workflow Dry Run

**Files:**
- Create: `src/workflows/dry-run.ts`
- Create: `src/workflows/contracts.ts`
- Create: `tests/workflow-evaluation.test.ts`
- Modify: `src/routes/workflows.ts`
- Modify: `web-stitch/src/api.ts`
- Modify: `web-stitch/src/features/workflows/WorkflowsPage.tsx`

**Interfaces:**
- Produces `dryRunWorkflow`.
- Produces `POST /v1/workflows/:id/dry-run`.
- Dry run never invokes an adapter.

- [ ] **Step 1: Write failing dry-run tests**

```ts
it('resolves topology and contracts without invoking adapters', async () => {
  const result = await dryRunWorkflow({
    workspaceId,
    definition,
    input: fixtureInput,
    adapterSpy,
  });

  expect(adapterSpy).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    valid: true,
    externalActions: expect.any(Array),
    requiredApprovals: expect.any(Array),
    estimatedBudgets: expect.any(Object),
  });
});

it('rejects incompatible connected schemas before execution', async () => {
  const result = await dryRunWorkflow({
    workspaceId,
    definition: incompatibleDefinition,
    input: fixtureInput,
    adapterSpy,
  });
  expect(result.errors).toContainEqual(
    expect.objectContaining({ code: 'NODE_SCHEMA_INCOMPATIBLE' }),
  );
});
```

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/workflow-evaluation.test.ts
```

- [ ] **Step 3: Implement dry-run compiler**

Dry run performs:

- Registry validation.
- Topological reachability and ancestor checks.
- Input-reference resolution against supplied fixture input.
- Required/optional binding checks.
- Input/output schema compatibility.
- Resource existence and agent-version checks.
- Permission and approval preview.
- Budget estimation.
- Loop-bound validation.
- Manifest preview with hashes but no persisted production run.

`contracts.ts` defines typed input and output ports for registry nodes. A binding records source node, source port, target node, target port, required/optional status, nullability, and JSON Schema. Compatibility accepts identical types, safe required-to-optional widening, and explicitly registered transformations; it rejects implicit scalar/object/array coercion.

Return structured errors and warnings. Do not call model, tool, MCP, browser, file, or artifact adapters.

- [ ] **Step 4: Add UI**

Add **Dry run** beside **Test draft**. Display:

- Valid/invalid status.
- Resolved execution path.
- External actions.
- Required approvals.
- Missing resources.
- Estimated budget.
- Errors and recovery guidance.

- [ ] **Step 5: Verify**

```bash
npm test -- tests/workflow-evaluation.test.ts tests/workflows.test.ts
npm --prefix web-stitch run build
npm --prefix web-stitch run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/workflows/dry-run.ts src/routes/workflows.ts web-stitch/src/api.ts web-stitch/src/features/workflows/WorkflowsPage.tsx tests/workflow-evaluation.test.ts
git commit -m "feat: add no-side-effect workflow dry run"
```

### Task 5: Fixture-Based Regression Evaluation

**Files:**
- Create: `src/workflows/evaluation.ts`
- Modify: `src/db/migrations/032_quality_memory_evaluation.sql`
- Modify: `src/routes/workflows.ts`
- Modify: `web-stitch/src/api.ts`
- Modify: `web-stitch/src/features/workflows/WorkflowsPage.tsx`
- Modify: `tests/workflow-evaluation.test.ts`

**Interfaces:**
- Produces CRUD for workflow regression cases.
- Produces `runWorkflowEvaluation`.
- External action nodes require explicit fixtures.

- [ ] **Step 1: Write failing evaluation tests**

```ts
it('uses fixtures instead of live external actions', async () => {
  const result = await runWorkflowEvaluation({
    workflowVersionId,
    caseId,
    fixtures: {
      'api:weather.lookup': { temperature: 31 },
      'mcp:notion.search': { results: [] },
    },
    liveActionSpy,
  });
  expect(liveActionSpy).not.toHaveBeenCalled();
  expect(result.status).toBe('passed');
});

it('fails closed when an external fixture is missing', async () => {
  await expect(runWorkflowEvaluation({
    workflowVersionId,
    caseId: missingFixtureCaseId,
    fixtures: {},
    liveActionSpy,
  })).rejects.toMatchObject({ code: 'EVALUATION_FIXTURE_REQUIRED' });
});
```

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/workflow-evaluation.test.ts
```

- [ ] **Step 3: Add evaluation schema**

```sql
CREATE TABLE workflow_regression_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  input JSONB NOT NULL,
  fixtures JSONB NOT NULL DEFAULT '{}'::jsonb,
  assertions JSONB NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workflow_evaluation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_version_id UUID NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,
  regression_case_id UUID NOT NULL REFERENCES workflow_regression_cases(id) ON DELETE CASCADE,
  execution_manifest JSONB NOT NULL,
  trace_id UUID NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','passed','failed')),
  measurements JSONB NOT NULL DEFAULT '{}'::jsonb,
  assertion_results JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
```

Assertions initially support:

```text
output.json_path equals
output.json_path contains
output.schema conforms
cost_usd <=
duration_ms <=
quality.score >=
```

- [ ] **Step 4: Implement fixture adapter boundary**

Evaluation mode replaces API, MCP, browser, and file-source adapters with a fixture adapter keyed by stable adapter/resource/operation identity. Model nodes may run using the pinned model and count real evaluation cost; the UI must disclose this before starting.

- [ ] **Step 5: Verify**

```bash
npm test -- tests/workflow-evaluation.test.ts tests/workflows.test.ts tests/database.integration.test.ts
npm --prefix web-stitch run build
npm --prefix web-stitch run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/032_quality_memory_evaluation.sql src/workflows/evaluation.ts src/routes/workflows.ts web-stitch/src/api.ts web-stitch/src/features/workflows/WorkflowsPage.tsx tests/workflow-evaluation.test.ts
git commit -m "feat: add workflow regression evaluation"
```

### Task 6: Replay and Memory Management UI

**Files:**
- Create: `src/runtime/replay.ts`
- Create: `web-stitch/src/features/memory/MemoryPage.tsx`
- Modify: `web-stitch/src/features/execution/ExecutionPage.tsx`
- Modify: `web-stitch/src/api.ts`
- Modify: `web-stitch/src/App.tsx`
- Modify: `web-stitch/src/app/AppShell.tsx`
- Modify: `src/routes/workflows.ts`
- Test: `web-stitch/src/features/departments/department-layout.test.ts` or create focused UI tests.

**Interfaces:**
- Produces a trace-ordered replay endpoint.
- Produces a Memory management subpage.

- [ ] **Step 1: Write failing replay ordering test**

```ts
it('orders replay events by trace time and stable sequence', async () => {
  const replay = await getWorkflowReplay(workspaceId, runId);
  expect(replay.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  expect(replay.events.every((event) => event.traceId === traceId)).toBe(true);
});
```

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/workflow-evaluation.test.ts
```

- [ ] **Step 3: Add replay response**

Implement `getWorkflowReplay` in `src/runtime/replay.ts`. Merge workflow events, node states, task events, action authorizations, quality history, usage, and artifact events by trace identity. Return redacted inputs/outputs appropriate to the requesting workspace role.

Each replay event includes:

```ts
type ReplayEvent = {
  sequence: number;
  timestamp: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  kind: string;
  title: string;
  durationMs: number | null;
  costUsd: number | null;
  status: string;
  summary: Record<string, unknown>;
};
```

- [ ] **Step 4: Add UI**

Execution detail shows:

- Trace timeline.
- Model and agent versions.
- Costs and durations.
- Quality attempts linked to output versions.
- Structured errors and recovery guidance.

Memory management is a secondary Knowledge or Settings route with filters and actions to confirm, dispute, supersede, edit, delete, pin by importance, and change scope/expiry. It is not another primary sidebar item.

- [ ] **Step 5: Verify**

```bash
npm test -- tests/workflow-evaluation.test.ts tests/memory-governance.test.ts
npm --prefix web-stitch exec vitest run
npm --prefix web-stitch run build
npm --prefix web-stitch run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/runtime/replay.ts src/routes/workflows.ts web-stitch/src/features/memory/MemoryPage.tsx web-stitch/src/features/execution/ExecutionPage.tsx web-stitch/src/api.ts web-stitch/src/App.tsx web-stitch/src/app/AppShell.tsx tests/workflow-evaluation.test.ts
git commit -m "feat: add replay and governed memory UI"
```

### Task 7: Quality, Memory, and Evaluation Acceptance Gate

**Files:**
- Verify only. Return to the owning task before changing a file when a check fails.

- [ ] **Step 1: Run focused tests**

```bash
npm test -- tests/quality-history.test.ts tests/memory-governance.test.ts tests/workflow-evaluation.test.ts tests/workflows.test.ts tests/agent-runtime.test.ts tests/editable-output.test.ts
```

- [ ] **Step 2: Run full verification**

```bash
npm test
npm run build
npm --prefix web-stitch exec vitest run
npm --prefix web-stitch run build
npm --prefix web-stitch run lint
```

- [ ] **Step 3: Run database integration**

```bash
npm test -- tests/database.integration.test.ts
```

- [ ] **Step 4: Verify acceptance scenarios**

```text
Every grade identifies an exact candidate output and grader version
Earlier grades cannot be overwritten
Agent-inferred memory is not presented as user-confirmed
Expired, disputed, and superseded memory is not normally retrieved
Scope blocks one agent from receiving another agent's restricted memory
Dry run invokes no runtime adapters
Regression external actions require fixtures and never fall back to live calls
Replay events share the run trace identity and contain no secrets
Evaluation cost is disclosed and measured
```
