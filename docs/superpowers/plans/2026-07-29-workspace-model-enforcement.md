# Workspace Model Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a saved workspace AI provider model the enforced model for all workspace agents, new solution installs, and future workflow tests/runs.

**Architecture:** Extend the provider-save transaction so it updates all agent drafts and republishes only agents that already have published versions. Workflows keep their immutable historical runs and reference agent IDs, so new manifests automatically resolve the replacement published versions. Pass the workspace default model into solution installation rather than reading the process-level Claude fallback.

**Tech Stack:** Fastify, TypeScript, PostgreSQL, Vitest, React, TanStack Query.

## Global Constraints

- Keep API keys encrypted and out of responses, audit payloads, logs, and tests.
- Preserve historical `agent_versions`, workflow runs, execution manifests, and usage records unchanged.
- Make provider configuration and bulk agent changes one transaction; failure rolls back both.
- Do not alter agent tool grants, capabilities, workflow definitions, policies, or legacy tool compatibility.
- Run targeted tests during each task; run the affected backend and frontend suites after the final task.

---

### Task 1: Atomic workspace model enforcement service

**Files:**
- Modify: `src/agents/versions.ts`
- Modify: `tests/agent-versions.test.ts`

**Interfaces:**
- Produces: `enforceWorkspaceAgentModel(client, { workspaceId, actorId, model }): Promise<{ agentsUpdated: number; versionsPublished: number }>`.
- Consumes: existing private `publishWithClient` and immutable `AgentVersionSnapshot` creation.
- Used by: `src/routes/runtime.ts` inside its provider-save transaction.

- [ ] **Step 1: Add a failing integration test for model enforcement**

Create one workspace with: a draft agent, an active agent with a published `model-a` version, and an active agent with a published `model-b` version. Invoke the new service with `model-c`; assert all drafts now have `model-c`, the two active agents each have a new published version with snapshot model `model-c`, and the prior versions still have their original models.

```ts
const result = await enforceWorkspaceAgentModel(client, { workspaceId, actorId, model: 'model-c' });
expect(result).toEqual({ agentsUpdated: 3, versionsPublished: 2 });
expect(previous.snapshot.model).toBe('model-a');
expect((await resolvePublishedAgentVersion(workspaceId, activeId)).snapshot.model).toBe('model-c');
```

- [ ] **Step 2: Run the integration test to confirm the missing service fails**

Run: `RUN_INTEGRATION=true npm test -- tests/agent-versions.test.ts`

Expected: FAIL because `enforceWorkspaceAgentModel` does not exist.

- [ ] **Step 3: Implement the smallest transactional helper**

Lock workspace agents in deterministic ID order, update their `model`, and call `publishWithClient` only for agents whose `published_version_id` is non-null. Return counts. The helper must not begin, commit, or roll back a transaction; its caller owns the transaction.

```ts
export async function enforceWorkspaceAgentModel(
  client: PoolClient,
  input: { workspaceId: string; actorId: string; model: string },
): Promise<{ agentsUpdated: number; versionsPublished: number }>;
```

- [ ] **Step 4: Run the integration test and agent-version suite**

Run: `RUN_INTEGRATION=true npm test -- tests/agent-versions.test.ts`

Expected: PASS, including sequential immutable version assertions.

- [ ] **Step 5: Commit the focused service and test**

```bash
git add src/agents/versions.ts tests/agent-versions.test.ts
git commit -m "feat: enforce workspace model across agents"
```

### Task 2: Provider-save transaction and response contract

**Files:**
- Modify: `src/routes/runtime.ts`
- Modify: `tests/runtime-config.test.ts`
- Create: `tests/runtime-model-enforcement.integration.test.ts`

**Interfaces:**
- Consumes: `enforceWorkspaceAgentModel(client, input)` from Task 1.
- Produces: runtime configuration response with `modelEnforcement: { agentsUpdated: number; versionsPublished: number }` when a save changes provider or model; zero counts when it does not.
- Used by: `web-stitch/src/api.ts` and `ProviderSettingsPanel` in Task 4.

- [ ] **Step 1: Add failing route-level tests**

Test a provider/model change with a mocked safe provider configuration and an existing published agent. Assert the route returns aggregate counts, writes the provider row and replacement agent version together, and exposes neither the API key nor encrypted credential. Add a database-failure case after the provider upsert and assert the transaction leaves both model and configuration unchanged.

```ts
expect(response.body.modelEnforcement).toEqual({ agentsUpdated: 2, versionsPublished: 1 });
expect(JSON.stringify(response.body)).not.toContain('test-compatible-key');
```

- [ ] **Step 2: Run only the new route tests to verify failure**

Run: `RUN_INTEGRATION=true npm test -- tests/runtime-model-enforcement.integration.test.ts`

Expected: FAIL because the provider route currently writes only `workspace_ai_provider_configs`.

- [ ] **Step 3: Wrap provider persistence and enforcement in one transaction**

Replace the standalone `query` upsert in `PUT /v1/runtime/config` with a `db.connect()` transaction. Preserve current validation, credential encryption, `changed` status reset, and audit behavior. Run enforcement only when provider or model changes; include its aggregate result in the response and audit event. On error, roll back and release the client before returning the existing safe error format.

- [ ] **Step 4: Run targeted backend verification**

Run: `RUN_INTEGRATION=true npm test -- tests/runtime-model-enforcement.integration.test.ts tests/runtime-config.test.ts tests/agent-versions.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the atomic provider update**

```bash
git add src/routes/runtime.ts tests/runtime-config.test.ts tests/runtime-model-enforcement.integration.test.ts
git commit -m "feat: apply provider model to workspace agents"
```

### Task 3: Make solution installation inherit the workspace model

**Files:**
- Modify: `src/solutions/installer.ts`
- Modify: `src/routes/agent-solutions.ts`
- Modify: `tests/agent-solution-transaction.test.ts`

**Interfaces:**
- Extends: `InstallInput` with required `defaultModel: string`.
- Consumes: `configuredAiProviderForWorkspace(workspaceId)` in the installation route.
- Produces: agents created with `agent.model ?? input.defaultModel`, never `LLM_DEFAULT_MODEL`.

- [ ] **Step 1: Add a failing installer test**

Pass a solution whose agent omits `model` and `defaultModel: 'glm-4.6'`; assert the agent insert receives `glm-4.6`. Add a second assertion that an explicitly supplied solution model is preserved.

```ts
expect(agentInsertParameters[6]).toBe('glm-4.6');
expect(explicitModelInsertParameters[6]).toBe('specialist-model');
```

- [ ] **Step 2: Run the solution-transaction test to verify failure**

Run: `npm test -- tests/agent-solution-transaction.test.ts`

Expected: FAIL because installation currently falls back to `process.env.LLM_DEFAULT_MODEL`.

- [ ] **Step 3: Inject the workspace default model**

Remove the process environment fallback from `installWithClient`. In the install route, resolve the workspace provider before installation and pass `runtime.defaultModel`; if no provider is configured, retain the existing safe provider-configuration error rather than silently creating Claude-bound agents.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- tests/agent-solution-transaction.test.ts tests/agent-solutions.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the installer correction**

```bash
git add src/solutions/installer.ts src/routes/agent-solutions.ts tests/agent-solution-transaction.test.ts
git commit -m "fix: inherit workspace model for solution agents"
```

### Task 4: Explicit provider-settings confirmation and feedback

**Files:**
- Modify: `web-stitch/src/api.ts`
- Modify: `web-stitch/src/features/settings/ProviderSettingsPanel.tsx`
- Create: `web-stitch/src/features/settings/ProviderSettingsPanel.test.tsx`

**Interfaces:**
- Consumes: `RuntimeConfig.modelEnforcement` from Task 2.
- Produces: an explicit confirmation before a changed provider/model is saved, and a success message with non-sensitive aggregate counts.

- [ ] **Step 1: Add failing component tests**

Verify that an unchanged save does not ask for confirmation, a provider or model change asks for confirmation with “all agents,” cancellation sends no request, and confirmed success reports the returned counts.

```tsx
await user.click(screen.getByRole('button', { name: 'Save provider' }));
expect(screen.getByText(/apply.*every agent/i)).toBeVisible();
await user.click(screen.getByRole('button', { name: /apply model/i }));
expect(api.updateRuntimeConfig).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Run the component test to verify failure**

Run: `npm --prefix web-stitch test -- ProviderSettingsPanel.test.tsx`

Expected: FAIL because saving currently has no confirmation or aggregate response handling.

- [ ] **Step 3: Implement the confirmation flow and accurate copy**

Extend `RuntimeConfig` with optional `modelEnforcement` counts. Replace the current statement that existing agents keep their selected model with copy that explains model changes apply workspace-wide. Require confirmation only when provider or model differs from the loaded configuration; API-key-only saves remain immediate.

- [ ] **Step 4: Run frontend verification**

Run: `npm --prefix web-stitch test -- ProviderSettingsPanel.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the user-facing safeguard**

```bash
git add web-stitch/src/api.ts web-stitch/src/features/settings/ProviderSettingsPanel.tsx web-stitch/src/features/settings/ProviderSettingsPanel.test.tsx
git commit -m "feat: confirm workspace-wide model changes"
```

### Task 5: Cross-boundary verification and source review

**Files:**
- Review: `src/routes/runtime.ts`, `src/agents/versions.ts`, `src/solutions/installer.ts`, `src/routes/agent-solutions.ts`, `web-stitch/src/features/settings/ProviderSettingsPanel.tsx`
- Review: tests added in Tasks 1–4

- [ ] **Step 1: Run backend model-change regression tests**

Run: `RUN_INTEGRATION=true npm test -- tests/runtime-model-enforcement.integration.test.ts tests/runtime-config.test.ts tests/agent-versions.test.ts tests/agent-solution-transaction.test.ts tests/agent-solutions.test.ts`

Expected: PASS.

- [ ] **Step 2: Run the relevant frontend suite and build**

Run: `npm --prefix web-stitch test -- ProviderSettingsPanel.test.tsx && npm --prefix web-stitch run build`

Expected: PASS.

- [ ] **Step 3: Perform one source-verified review**

Confirm the transaction has one commit boundary, the response/audit contains only counts and model metadata, old published snapshots are not updated in place, and no installer path reads `LLM_DEFAULT_MODEL` for an unspecified solution model.

- [ ] **Step 4: Record only Critical or Important corrections, then make one consolidated correction pass**

Run the directly affected tests again after corrections. Defer Minor findings to final branch review.

