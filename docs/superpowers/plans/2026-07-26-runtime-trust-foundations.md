# Runtime Trust Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make production runs reproducible, traceable, selectively retryable, cooperatively cancellable, and protected from duplicate workers.

**Architecture:** Publish immutable agent versions, freeze all runtime dependencies in an execution manifest, propagate trace and cancellation contexts through adapters, normalize errors into one taxonomy, and use database-backed leases around task and workflow execution. Keep the existing action-policy gateway as the authority for external side effects.

**Tech Stack:** PostgreSQL, Fastify 5, BullMQ/Redis, TypeScript, Vitest, OpenAI/Anthropic SDKs, MCP SDK.

## Global Constraints

- Extend existing workflow snapshots and action authorizations; do not create competing snapshot or side-effect systems.
- Production tasks and workflow agent nodes use published agent versions.
- Paused runs resume from their stored manifest.
- Write-capable actions are never automatically repeated after an uncertain remote outcome.
- Queue retries must not multiply logical node retries.
- Cancellation must report side effects honestly; cancellation is not rollback.
- Trace and error details must be redacted before reaching browser APIs.

---

## File Structure

- Create `src/db/migrations/030_agent_versions_and_manifests.sql`: version and manifest storage.
- Create `src/agents/versions.ts`: publish, resolve, and diff immutable agent versions.
- Create `src/runtime/manifest.ts`: build and validate execution manifests.
- Create `src/runtime/trace.ts`: trace context creation and propagation.
- Create `src/runtime/errors.ts`: structured error taxonomy and serializer.
- Create `src/runtime/cancellation.ts`: database-backed cancellation polling and abort signal.
- Create `src/runtime/leases.ts`: acquire, heartbeat, release, and expire leases.
- Create `src/runtime/approval-expiry.ts`: expire or escalate overdue approvals.
- Create `src/db/migrations/031_runtime_trust.sql`: trace, cancellation, and lease schema.
- Modify `src/routes/agents.ts`: publish endpoint and version reads.
- Modify `src/routes/tasks.ts`: create with agent version and request cancellation.
- Modify `src/routes/workflows.ts`: create manifests, request cancellation, expose redacted trace/error data.
- Modify `src/lib/agent-runtime.ts`: resolve version snapshots.
- Modify `src/workflows/adapters/types.ts`: execution context.
- Modify `src/workflows/adapters/agent.ts`, `api.ts`, `file.ts`, `index.ts`, `knowledge.ts`, `legacy-tool.ts`, `logic.ts`, `mcp.ts`, and `types.ts`: accept and propagate signal, trace, manifest, and structured errors. `templates.ts` remains pure and does not consume execution context.
- Modify `src/queue/task-queue.ts`: remove nested logical retries and carry trace IDs.
- Modify `src/worker.ts`: leases, heartbeats, manifest resolution, and cancellation.
- Modify `src/workflows/runtime.ts`: trace/error/retry/cancellation state machine.
- Modify `src/policy/action-gateway.ts`: include trace identity without changing action identity.
- Modify `src/mcp/runtime.ts`, `src/mcp/transports/streamable-http.ts`, `src/tools/runtime.ts`, `src/lib/ai-provider.ts`, `src/files/service.ts`, and `src/artifacts/service.ts`: accept caller abort signals.
- Create `tests/agent-versions.test.ts`.
- Create `tests/execution-manifest.test.ts`.
- Create `tests/runtime-errors.test.ts`.
- Create `tests/runtime-cancellation.test.ts`.
- Create `tests/runtime-leases.test.ts`.
- Create `tests/approval-expiry.test.ts`.
- Modify `tests/workflows.test.ts`, `tests/queue.test.ts`, and `tests/database.integration.test.ts`.

### Task 1: Immutable Agent Versions

**Files:**
- Create: `src/db/migrations/030_agent_versions_and_manifests.sql`
- Create: `src/agents/versions.ts`
- Create: `tests/agent-versions.test.ts`
- Modify: `src/routes/agents.ts`
- Modify: `src/lib/agent-runtime.ts`

**Interfaces:**
- Produces `publishAgent({ workspaceId, agentId, actorId }): Promise<AgentVersion>`.
- Produces `resolvePublishedAgentVersion(workspaceId, agentId): Promise<AgentVersion>`.
- Produces `GET /v1/agents/:id/versions` and `POST /v1/agents/:id/publish`.

- [ ] **Step 1: Write failing version tests**

```ts
it('publishes immutable sequential agent versions', async () => {
  const first = await publishAgent({ workspaceId, agentId, actorId });
  await query('UPDATE agents SET instructions=$1 WHERE id=$2', ['Changed', agentId]);
  const second = await publishAgent({ workspaceId, agentId, actorId });

  expect(first.version).toBe(1);
  expect(second.version).toBe(2);
  expect(first.snapshot.instructions).not.toBe(second.snapshot.instructions);
});

it('does not mutate a published snapshot when the draft changes', async () => {
  const published = await publishAgent({ workspaceId, agentId, actorId });
  await query('UPDATE agents SET model=$1 WHERE id=$2', ['different-model', agentId]);
  const stored = await getAgentVersion(workspaceId, published.id);
  expect(stored.snapshot.model).toBe(published.snapshot.model);
});
```

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/agent-versions.test.ts
```

Expected: FAIL because agent version storage does not exist.

- [ ] **Step 3: Add schema**

Add:

```sql
CREATE TABLE agent_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  snapshot JSONB NOT NULL,
  published_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(agent_id,version)
);

ALTER TABLE agents
  ADD COLUMN published_version_id UUID REFERENCES agent_versions(id) ON DELETE SET NULL;

ALTER TABLE tasks
  ADD COLUMN agent_version_id UUID REFERENCES agent_versions(id) ON DELETE RESTRICT;

ALTER TABLE workflow_runs
  ADD COLUMN manifest_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN execution_manifest JSONB;
```

Backfill version 1 for active agents, set `published_version_id`, and set existing task `agent_version_id` where the task's agent has a backfilled version. Historical rows without a resolvable version remain explicitly marked by a manifest compatibility flag; do not invent an exact historical snapshot.

- [ ] **Step 4: Implement publish transaction**

Freeze:

```ts
export type AgentVersionSnapshot = {
  name: string;
  role: string;
  goal: string;
  instructions: string;
  personality: string | null;
  model: string;
  modelConfig: AgentModelConfig;
  capabilities: AgentCapabilities;
  apiToolIds: string[];
  memoryConfig: Record<string, unknown>;
  avatarIdentity: Record<string, unknown>;
};
```

MCP allowlists remain stored in MCP access tables; the execution manifest records the resolved MCP actions for a run.

Publishing locks the agent row, computes the next version, inserts the snapshot, and updates `agents.published_version_id` in one transaction.

- [ ] **Step 5: Verify**

```bash
npm test -- tests/agent-versions.test.ts tests/runtime-config.test.ts tests/agent-runtime.test.ts
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/030_agent_versions_and_manifests.sql src/agents/versions.ts src/routes/agents.ts src/lib/agent-runtime.ts tests/agent-versions.test.ts
git commit -m "feat: publish immutable agent versions"
```

### Task 2: Complete Execution Manifests

**Files:**
- Create: `src/runtime/manifest.ts`
- Create: `tests/execution-manifest.test.ts`
- Modify: `src/routes/tasks.ts`
- Modify: `src/routes/workflows.ts`
- Modify: `src/workflows/adapters/agent.ts`
- Modify: `src/worker.ts`
- Test: `tests/database.integration.test.ts`

**Interfaces:**
- Produces `buildTaskManifest`.
- Produces `buildWorkflowManifest`.
- Produces `validateManifestCompatibility`.

- [ ] **Step 1: Write failing manifest tests**

```ts
it('freezes every production workflow dependency', async () => {
  const manifest = await buildWorkflowManifest({
    workspaceId,
    workflowVersionId,
    definition,
  });

  expect(manifest).toMatchObject({
    manifestVersion: 1,
    workflow: { versionId: workflowVersionId },
    runtime: { version: expect.any(String), stateSchemaVersion: 1 },
  });
  expect(manifest.agents[agentId].versionId).toBe(agentVersionId);
  expect(manifest.apiTools[apiToolId].schemaHash).toMatch(/^[a-f0-9]{64}$/);
  expect(manifest.mcpActions[mcpToolId].schemaHash).toMatch(/^[a-f0-9]{64}$/);
});

it('rejects production execution when an agent node has no published version', async () => {
  await expect(buildWorkflowManifest({
    workspaceId,
    workflowVersionId,
    definition: draftAgentDefinition,
  })).rejects.toMatchObject({ code: 'AGENT_VERSION_REQUIRED' });
});
```

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/execution-manifest.test.ts
```

- [ ] **Step 3: Define exact manifest**

```ts
export interface ExecutionManifest {
  manifestVersion: 1;
  createdAt: string;
  compatibility: 'exact' | 'legacy_partial';
  workflow?: { id: string; versionId: string; version: number; definitionHash: string };
  agents: Record<string, { versionId: string; version: number; snapshotHash: string }>;
  prompts: Record<string, { versionId: string; contentHash: string }>;
  models: Record<string, { provider: string; model: string; parametersHash: string }>;
  apiTools: Record<string, { toolId: string; schemaHash: string; permissionHash: string }>;
  mcpActions: Record<string, { connectionId: string; toolId: string; schemaHash: string; permissionHash: string }>;
  policy: { version: string };
  adapters: Record<string, string>;
  outputContracts: Record<string, string>;
  artifactTemplates: Record<string, string>;
  runtime: { version: string; stateSchemaVersion: 1 };
}
```

Canonicalize JSON object keys before SHA-256 hashing. Never store credentials in manifests.

Build and persist the manifest in the same transaction that creates a production task or workflow run. Agent workflow tasks receive the version ID from `manifest.agents`, not from the live agent row.

- [ ] **Step 4: Add resume compatibility checks**

Before resuming an approval:

```ts
const compatibility = validateManifestCompatibility(run.execution_manifest);
if (!compatibility.ok) {
  throw runtimeError('RUN_MANIFEST_INCOMPATIBLE', {
    category: 'validation',
    retryable: false,
    details: { reasons: compatibility.reasons },
  });
}
```

- [ ] **Step 5: Verify**

```bash
npm test -- tests/execution-manifest.test.ts tests/workflows.test.ts tests/database.integration.test.ts
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/runtime/manifest.ts src/routes/tasks.ts src/routes/workflows.ts src/workflows/adapters/agent.ts src/worker.ts tests/execution-manifest.test.ts tests/database.integration.test.ts
git commit -m "feat: freeze complete execution manifests"
```

### Task 3: Trace Context and Structured Runtime Errors

**Files:**
- Create: `src/db/migrations/031_runtime_trust.sql`
- Create: `src/runtime/trace.ts`
- Create: `src/runtime/errors.ts`
- Create: `tests/runtime-errors.test.ts`
- Modify: `src/workflows/adapters/types.ts`
- Modify: `src/workflows/runtime.ts`
- Modify: `src/worker.ts`
- Modify: `src/policy/action-gateway.ts`

**Interfaces:**
- Produces `TraceContext`.
- Produces `RuntimeErrorCategory`, `WorkflowRuntimeError`, `runtimeError`, and `serializeRuntimeError`.
- All adapters consume `ExecutionContext`.

- [ ] **Step 1: Write failing unit tests**

```ts
it('serializes a redacted structured error', () => {
  const error = runtimeError('TOOL_RATE_LIMITED', {
    category: 'rate_limited',
    retryable: true,
    message: 'Provider rejected api_key=secret-value',
    details: { apiKey: 'secret-value', retryAfterMs: 2000 },
  });

  expect(serializeRuntimeError(error)).toMatchObject({
    code: 'TOOL_RATE_LIMITED',
    category: 'rate_limited',
    retryable: true,
    details: { apiKey: '[REDACTED]', retryAfterMs: 2000 },
  });
});

it('creates child spans without changing the trace id', () => {
  const root = createTraceContext();
  const child = childTraceContext(root);
  expect(child.traceId).toBe(root.traceId);
  expect(child.parentSpanId).toBe(root.spanId);
  expect(child.spanId).not.toBe(root.spanId);
});
```

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/runtime-errors.test.ts
```

- [ ] **Step 3: Add schema and types**

Add UUID trace columns to tasks, workflow runs, node states, run events, task events, action authorizations, and MCP tool calls. Index `trace_id` with event time.

Define:

```ts
export type RuntimeErrorCategory =
  | 'transient'
  | 'rate_limited'
  | 'authentication'
  | 'validation'
  | 'policy_denied'
  | 'permanent'
  | 'cancelled'
  | 'timeout'
  | 'infrastructure'
  | 'unknown';

export interface ExecutionContext {
  trace: TraceContext;
  signal: AbortSignal;
  manifest: ExecutionManifest;
}
```

Persist only serialized, redacted error objects. Keep raw error objects in process memory only.

- [ ] **Step 4: Propagate context**

Create a root trace when creating a task or workflow run. Carry `traceId` in BullMQ job data. Create child spans for:

- Workflow node.
- Agent/model request.
- Knowledge retrieval.
- API Tool call.
- MCP action.
- Approval.
- File processing.
- Artifact generation.

Pass trace identity into the existing action-policy gateway without changing `action_key` or `arguments_hash`.

- [ ] **Step 5: Verify**

```bash
npm test -- tests/runtime-errors.test.ts tests/workflows.test.ts tests/mcp-permissions.test.ts
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/031_runtime_trust.sql src/runtime/trace.ts src/runtime/errors.ts src/workflows/adapters/types.ts src/workflows/runtime.ts src/worker.ts src/policy/action-gateway.ts tests/runtime-errors.test.ts
git commit -m "feat: add traceable structured runtime errors"
```

### Task 4: Retry Classification Without Multiplication

**Files:**
- Modify: `src/runtime/errors.ts`
- Modify: `src/workflows/runtime.ts`
- Modify: `src/queue/task-queue.ts`
- Modify: `src/worker.ts`
- Modify: `tests/workflows.test.ts`
- Modify: `tests/queue.test.ts`

**Interfaces:**
- Produces `retryDecision(error, policy): RetryDecision`.
- Workflow/task queues use one BullMQ attempt; runtime code owns logical retries.

- [ ] **Step 1: Write failing decision tests**

```ts
it.each([
  ['rate_limited', true],
  ['transient', true],
  ['authentication', false],
  ['validation', false],
  ['policy_denied', false],
  ['cancelled', false],
  ['permanent', false],
])('classifies %s retry behavior', (category, expected) => {
  expect(retryDecision(runtimeError('TEST', {
    category,
    retryable: expected,
    message: 'test',
  }), policy).retry).toBe(expected);
});

it('does not multiply BullMQ and node attempts', () => {
  expect(workflowQueueOptions.attempts).toBe(1);
  expect(taskQueueOptions.attempts).toBe(1);
});
```

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/runtime-errors.test.ts tests/workflows.test.ts tests/queue.test.ts
```

- [ ] **Step 3: Implement retry authority**

Set task and workflow queue attempts to 1. Keep queue retries for idempotent ingestion/file/artifact jobs where their services prove safe re-entry.

`retryDecision` honors:

1. Cancellation never retries.
2. Policy, validation, authentication, and permanent errors never retry.
3. Rate limits use bounded `retryAfterMs`.
4. Transient and timeout failures use node policy.
5. Write-capable or unknown-risk actions never automatically retry.
6. Uncertain remote outcomes return `ACTION_OUTCOME_UNCERTAIN`.

- [ ] **Step 4: Verify**

```bash
npm test -- tests/runtime-errors.test.ts tests/workflows.test.ts tests/queue.test.ts tests/mcp-permissions.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/runtime/errors.ts src/workflows/runtime.ts src/queue/task-queue.ts src/worker.ts tests/runtime-errors.test.ts tests/workflows.test.ts tests/queue.test.ts
git commit -m "fix: prevent multiplied runtime retries"
```

### Task 5: Cooperative Distributed Cancellation

**Files:**
- Create: `src/runtime/cancellation.ts`
- Create: `tests/runtime-cancellation.test.ts`
- Modify: `src/routes/tasks.ts`
- Modify: `src/routes/workflows.ts`
- Modify: `src/worker.ts`
- Modify: `src/workflows/runtime.ts`
- Modify: `src/mcp/runtime.ts`
- Modify: `src/mcp/transports/streamable-http.ts`
- Modify: `src/tools/runtime.ts`
- Modify: `src/lib/ai-provider.ts`
- Modify: `src/files/service.ts`
- Modify: `src/artifacts/service.ts`

**Interfaces:**
- Produces `createCancellationContext(subject): Promise<CancellationContext>`.
- API cancellation requests transition to `cancel_requested`.
- Worker finalizes `cancelled` or `cancelled_with_side_effects`.

- [ ] **Step 1: Write failing cancellation tests**

```ts
it('aborts an active adapter after a cancellation request', async () => {
  const context = await createCancellationContext({ kind: 'workflow_run', id: runId });
  const pending = waitForAbort(context.signal);
  await requestCancellation({ kind: 'workflow_run', id: runId, workspaceId, actorId });
  await expect(pending).resolves.toBe('aborted');
});

it('reports a consumed external action as a side effect', async () => {
  const status = await finalizeCancellation({ kind: 'workflow_run', id: runId });
  expect(status).toBe('cancelled_with_side_effects');
});
```

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/runtime-cancellation.test.ts
```

- [ ] **Step 3: Implement cancellation state**

Extend task and workflow statuses with:

```text
cancel_requested
cancelling
cancelled
cancelled_with_side_effects
```

The migration uses:

```sql
ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'cancel_requested';
ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'cancelling';
ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'cancelled_with_side_effects';
ALTER TYPE workflow_run_status ADD VALUE IF NOT EXISTS 'cancel_requested';
ALTER TYPE workflow_run_status ADD VALUE IF NOT EXISTS 'cancelling';
ALTER TYPE workflow_run_status ADD VALUE IF NOT EXISTS 'cancelled_with_side_effects';
```

The API sets `cancel_requested` conditionally and rejects unresolved approvals. The worker creates an `AbortController` and polls subject status at a bounded interval no greater than one second. On `cancel_requested`, it aborts local work and transitions to `cancelling`.

Combine caller cancellation with operation timeout using `AbortSignal.any([callerSignal, AbortSignal.timeout(limit)])`.

After adapters settle, inspect the existing action ledger:

- No consumed external actions: `cancelled`.
- One or more consumed or uncertain actions: `cancelled_with_side_effects`.

- [ ] **Step 4: Verify**

```bash
npm test -- tests/runtime-cancellation.test.ts tests/workflows.test.ts tests/mcp-streamable-http.test.ts tests/tools-validation.test.ts
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/runtime/cancellation.ts src/routes/tasks.ts src/routes/workflows.ts src/worker.ts src/workflows/runtime.ts src/mcp/runtime.ts src/mcp/transports/streamable-http.ts src/tools/runtime.ts src/lib/ai-provider.ts src/files/service.ts src/artifacts/service.ts tests/runtime-cancellation.test.ts
git commit -m "feat: propagate distributed cancellation"
```

### Task 6: Worker Leases and Execution Heartbeats

**Files:**
- Create: `src/runtime/leases.ts`
- Create: `tests/runtime-leases.test.ts`
- Modify: `src/db/migrations/031_runtime_trust.sql`
- Modify: `src/worker.ts`
- Modify: `src/workflows/runtime.ts`

**Interfaces:**
- Produces `acquireLease`, `heartbeatLease`, and `releaseLease`.
- Lease TTL is 30 seconds; heartbeat interval is 10 seconds.

- [ ] **Step 1: Write failing lease tests**

```ts
it('allows only one live owner for a subject', async () => {
  expect(await acquireLease(subject, 'worker-a', 30_000)).toBe(true);
  expect(await acquireLease(subject, 'worker-b', 30_000)).toBe(false);
});

it('allows takeover after expiry', async () => {
  await expireLeaseForTest(subject);
  expect(await acquireLease(subject, 'worker-b', 30_000)).toBe(true);
});
```

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/runtime-leases.test.ts
```

- [ ] **Step 3: Add lease table and atomic claims**

```sql
CREATE TABLE execution_leases (
  subject_type TEXT NOT NULL CHECK(subject_type IN ('task','workflow_run')),
  subject_id UUID NOT NULL,
  owner_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(subject_type,subject_id)
);
```

Acquisition uses one `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE expires_at <= now()` statement. Heartbeats update only when `owner_id` matches. Release deletes only the caller-owned lease.

Wrap task and workflow handlers:

```ts
const acquired = await acquireLease(subject, workerId, 30_000);
if (!acquired) return;
const heartbeat = startLeaseHeartbeat(subject, workerId, 10_000);
try {
  await execute();
} finally {
  heartbeat.stop();
  await releaseLease(subject, workerId);
}
```

- [ ] **Step 4: Verify**

```bash
npm test -- tests/runtime-leases.test.ts tests/queue.test.ts tests/workflows.test.ts
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/031_runtime_trust.sql src/runtime/leases.ts src/worker.ts src/workflows/runtime.ts tests/runtime-leases.test.ts
git commit -m "feat: protect execution with worker leases"
```

### Task 7: Approval Expiration Processing

**Files:**
- Create: `src/runtime/approval-expiry.ts`
- Create: `tests/approval-expiry.test.ts`
- Modify: `src/db/migrations/031_runtime_trust.sql`
- Modify: `src/worker.ts`
- Modify: `src/routes/action-authorizations.ts`

**Interfaces:**
- Produces `expireDueAuthorizations(batchSize): Promise<ExpirationResult>`.
- Supports expiration policies `fail`, `escalate`, and `auto_reject`.

- [ ] **Step 1: Write failing expiration tests**

```ts
it('atomically expires an overdue approval once', async () => {
  const first = await expireDueAuthorizations(100);
  const second = await expireDueAuthorizations(100);
  expect(first.expiredIds).toContain(authorizationId);
  expect(second.expiredIds).not.toContain(authorizationId);
});

it('escalates to an owner without approving the action', async () => {
  const result = await expireDueAuthorizations(100);
  expect(result.escalatedIds).toContain(authorizationId);
  const row = await getAuthorization(authorizationId);
  expect(row.status).toBe('awaiting_confirmation');
  expect(row.escalation_level).toBe(1);
});
```

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/approval-expiry.test.ts
```

- [ ] **Step 3: Extend authorization policy**

Add:

```sql
ALTER TABLE action_authorizations
  ADD COLUMN on_expiration TEXT NOT NULL DEFAULT 'auto_reject'
    CHECK(on_expiration IN ('fail','escalate','auto_reject')),
  ADD COLUMN escalation_level INTEGER NOT NULL DEFAULT 0 CHECK(escalation_level >= 0),
  ADD COLUMN escalated_at TIMESTAMPTZ;
```

Process due rows in batches using `FOR UPDATE SKIP LOCKED`.

- `auto_reject`: set authorization to `expired`, resolve the waiting task/run as rejected, and do not retry.
- `fail`: set authorization to `expired`, fail the waiting task/run with `APPROVAL_EXPIRED`.
- `escalate`: keep `awaiting_confirmation`, increment `escalation_level`, extend `expires_at` once by 24 hours, and create an owner/admin attention event. A second expiry auto-rejects.

No expiration path approves or invokes an action.

- [ ] **Step 4: Schedule bounded processing**

Run expiration processing from the worker every 30 seconds with an unref'd interval. The database row lock makes multiple workers safe. Run one batch at worker startup before starting the interval.

- [ ] **Step 5: Verify**

```bash
npm test -- tests/approval-expiry.test.ts tests/mcp-permissions.test.ts tests/workflows.test.ts
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/031_runtime_trust.sql src/runtime/approval-expiry.ts src/worker.ts src/routes/action-authorizations.ts tests/approval-expiry.test.ts
git commit -m "feat: process approval expiration policies"
```

### Task 8: Runtime Trust Acceptance Gate

**Files:**
- Verify only. Return to the owning task before changing a file when a check fails.

- [ ] **Step 1: Run focused and full backend tests**

```bash
npm test -- tests/agent-versions.test.ts tests/execution-manifest.test.ts tests/runtime-errors.test.ts tests/runtime-cancellation.test.ts tests/runtime-leases.test.ts tests/approval-expiry.test.ts tests/workflows.test.ts tests/queue.test.ts tests/mcp-permissions.test.ts
npm test
npm run build
```

- [ ] **Step 2: Run database integration**

```bash
npm test -- tests/database.integration.test.ts
```

- [ ] **Step 3: Verify acceptance scenarios**

```text
Editing an agent does not change an existing production run
Paused runs resume from their frozen manifest
Every run, node, tool action, and artifact is correlated by trace ID
Browser APIs return only redacted structured errors
Authentication, validation, policy, cancellation, and permanent errors do not retry
Task/workflow BullMQ delivery does not multiply logical retries
Cancellation aborts supported active operations within the polling bound
Completed or uncertain external side effects are reported honestly
A second worker cannot execute a live leased subject
Expired leases can be safely reclaimed
```
