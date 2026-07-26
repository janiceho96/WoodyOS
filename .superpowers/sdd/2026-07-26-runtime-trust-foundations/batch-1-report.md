# Phase 3 Batch 1 Report: Agent Versions and Execution Manifests

## Outcome

Implemented immutable published agent versions and exact execution manifests for production tasks and workflow runs. Production execution now binds to published agent-version snapshots, workflow agent tasks inherit the run manifest/version identity, and resumed production work rejects missing, legacy-partial, sensitive, malformed, unsupported, or live-drifted manifests.

## Dependency and transaction decisions

- Extended the existing `workflow_runs.definition_snapshot` and action-authorization/checkpoint model. No competing snapshot or approval system was introduced.
- Added task manifest storage because Task 2 explicitly requires production task manifests to be persisted with task creation; the abbreviated Task 1 schema listed only the workflow columns.
- Used composite foreign keys `(version_id, agent_id, workspace_id)` so an agent or task cannot reference another workspace’s or another agent’s published version.
- Agent publishing locks the draft agent row. The lock serializes version allocation, then inserts the immutable snapshot and updates `agents.published_version_id` in one transaction.
- Production task manifest construction and task insertion share one transaction.
- Production workflow manifest construction and workflow-run insertion share one transaction.
- Draft/test workflow runs retain existing live-draft behavior and do not require published agent versions.
- Production workflow agent tasks copy the parent run manifest and take `agent_version_id` from `manifest.agents[agentId]`.
- The worker reconstructs the agent runtime from the stored agent-version snapshot, not the live draft row. Exact manifests also limit runtime tool IDs to the frozen manifest allowlist.
- API tool hashes cover input schema, endpoint, method, read-only classification, kind, and permissions without storing configuration or headers.
- MCP hashes cover input schema, remote action identity, transport, endpoint, and per-agent permission classifications without storing credentials.
- Workspace provider identity, nonsecret endpoint/default-model configuration, and agent model parameters are hashed without reading or persisting encrypted API keys.
- Before each production provider call, action authorization, and external-action claim, runtime validation recomputes all executable dependency descriptors from live rows and compares them with the stored manifest.
- Approval-resume routes perform that validation inside the same transaction and before any approval, checkpoint, task, or workflow state mutation.
- Existing `tools.kind='mcp'` values remain in the versioned agent tool-ID list and existing runtime path.
- Department schema/behavior and delegation remain untouched.

## RED evidence

- `npm test -- tests/agent-versions.test.ts`
  - Failed because `src/agents/versions.ts` did not exist.
- `npm test -- tests/execution-manifest.test.ts`
  - Failed because `src/runtime/manifest.ts` did not exist.
- `npm test -- tests/agent-runtime.test.ts`
  - Failed because `agentRuntimeSourceFromSnapshot` did not exist.
- `npm test -- tests/execution-manifest.test.ts`
  - Failed because a runtime state schema version of 2 was incorrectly accepted.
- `npm test -- tests/execution-manifest.test.ts`
  - Failed because malformed nested agent entries were accepted and no live dependency comparison existed.
- `npm test -- tests/manifest-resume-routes.test.ts`
  - All three route cases failed because action, workflow-action, and MCP confirmations mutated state and enqueued work without an exact-manifest gate.

Each failure was the expected missing behavior before the corresponding production change.

## GREEN evidence

- Focused batch command:
  - `npm test -- tests/agent-versions.test.ts tests/execution-manifest.test.ts tests/runtime-config.test.ts tests/agent-runtime.test.ts tests/workflows.test.ts tests/database.integration.test.ts`
  - 30 passed; 37 integration-gated tests skipped; exit 0.
- Full non-integration suite:
  - `npm test`
  - 149 passed; 37 integration-gated tests skipped; exit 0.
- TypeScript build:
  - `npm run build`
  - exit 0.
- Whitespace validation:
  - `git diff --check`
  - exit 0.
- Correction-focused suite:
  - `npm test -- tests/execution-manifest.test.ts tests/manifest-resume-routes.test.ts`
  - 9 passed; 3 database-gated tests skipped; exit 0.
- Direct runtime/module suite:
  - `npm test -- tests/agent-runtime.test.ts tests/workflows.test.ts tests/runtime-config.test.ts`
  - 27 passed; exit 0.
- Complete non-database suite after the correction:
  - `npm test -- --exclude tests/health.test.ts`
  - 154 passed; 38 integration-gated tests skipped; exit 0.
- A complete `npm test` run also reached 154 passing tests; only `tests/health.test.ts` timed out waiting for the unavailable database.

## Database integration coverage

Added real PostgreSQL assertions for:

- migration backfill of version 1 for active agents;
- explicit `legacy_partial` manifests for historical tasks and workflow runs;
- migration idempotency when the SQL is run twice;
- immutable snapshot enforcement at the database layer;
- tenant-bound task/version foreign keys;
- sequential immutable publishing;
- cross-workspace version lookup rejection;
- complete workflow manifests containing agent, API-tool, and MCP-action hashes;
- rejection of production workflows whose agent nodes lack published versions;
- rejection when API configuration/permissions, MCP schema/risk/permissions, or workspace provider configuration drifts;
- API publish/list routes and persisted task/workflow manifests.

A safe targeted attempt was made with:

`RUN_INTEGRATION=true npm test -- tests/database.integration.test.ts -t "agent version and execution manifest migration"`

It could not connect because this worktree has no database password configured (`SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string`). No credentials were searched for or printed.

The coordinator subsequently confirmed that the migration 030 PostgreSQL integration had passed once in the shared validation environment, so it was not rerun during the correction pass.

## Files changed

- `src/db/migrations/030_agent_versions_and_manifests.sql`
- `src/agents/versions.ts`
- `src/runtime/manifest.ts`
- `src/routes/agents.ts`
- `src/routes/tasks.ts`
- `src/routes/workflows.ts`
- `src/routes/action-authorizations.ts`
- `src/routes/workflow-actions.ts`
- `src/routes/mcp/tool-calls.ts`
- `src/lib/agent-runtime.ts`
- `src/workflows/adapters/agent.ts`
- `src/workflows/adapters/api.ts`
- `src/workflows/adapters/mcp.ts`
- `src/workflows/adapters/legacy-tool.ts`
- `src/workflows/adapters/types.ts`
- `src/worker.ts`
- `tests/agent-versions.test.ts`
- `tests/execution-manifest.test.ts`
- `tests/agent-runtime.test.ts`
- `tests/database.integration.test.ts`
- `tests/manifest-resume-routes.test.ts`

## Self-review

- Canonical hashing sorts object keys recursively and preserves array order.
- Manifest validation rejects sensitive field names recursively.
- Exact manifests are validated strictly at every nested level; unknown or malformed fields fail closed.
- Live comparison covers stored agent versions/snapshots, provider configuration, agent model parameters, API schema/configuration/permissions, MCP schema/risk/permissions/bindings, prompts, artifact templates, policy, adapters, output contracts, and runtime versions.
- Production workflow tasks validate against the parent run's immutable workflow version, definition snapshot, and manifest. Test runs intentionally retain live/current behavior.
- Action-authorization, workflow-action, and MCP-confirmation routes validate before transaction mutations and do not enqueue incompatible resumes.
- No decrypted tool configuration, API key, MCP credential, raw header, or authorization value is stored in manifests.
- Historical rows are never labeled exact.
- Production routes require published agent versions while test workflows preserve draft execution.
- New foreign keys and all service queries include workspace boundaries.
- No Department delegation path was added or enabled.

## Residual risks

- Database integration tests are implemented but could not be executed in this environment because local database credentials were unavailable. They must be run against the existing migrated local PostgreSQL database before merge.
