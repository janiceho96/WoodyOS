# Phase 3 Batch 2a Report: Trace Context and Structured Runtime Errors

## Outcome

Implemented one traceable route-to-runtime vertical for task and workflow execution without adding retry authority. New task/workflow routes create cryptographically random UUID root traces, persist them with the subject, and place the authoritative trace ID in BullMQ payloads. Workers reject mismatched queue traces before claiming work, workflow adapters receive a discriminated `ExecutionContext`, and child spans cover workflow nodes, agent/model work, external actions, approvals, and MCP calls.

Runtime failures are normalized to approved categories and recursively redacted before persistence or browser exposure. Raw errors and stacks remain process-local.

## Migration 031

`src/db/migrations/031_runtime_trust.sql` contains the complete Phase 3 schema reservation:

- nullable UUID trace/span/parent linkage on tasks, workflow runs, workflow node states, task/workflow events, action authorizations, and MCP calls;
- trace/time indexes;
- structured workflow, action, and MCP error columns;
- future cancellation enum statuses;
- the future `execution_leases` table;
- future approval-expiration policy/escalation columns.

This batch does not implement cancellation, leases, approval expiry, or retry behavior. Per coordinator direction, PostgreSQL integration is not run locally; migration 031 is reserved for the once-per-migration-batch coordinator validation.

## RED evidence

- `npm test -- tests/runtime-errors.test.ts`
  - Failed because `src/runtime/errors.ts` and `src/runtime/trace.ts` did not exist.
  - A later cycle failed because authoritative DB/queue trace validation did not exist.
  - A later cycle failed because persisted structured error objects were not revalidated/redacted.
- `npm test -- tests/runtime-trace-flow.test.ts`
  - Both task and workflow route cases failed because root trace columns were absent from subject inserts and queue calls.
- `npm test -- tests/action-trace.test.ts`
  - Failed because action authorization inserts had no trace linkage.
- `npm test -- tests/runtime-persistence.test.ts`
  - Failed because workflow node/run errors persisted raw `{ message }` objects and node/events had no trace spans or `ExecutionContext`.
- `npm test -- tests/queue.test.ts`
  - Failed because BullMQ job data builders did not carry `traceId`.
- `npm test -- tests/runtime-browser-redaction.test.ts`
  - A deliberate mutation removing task-detail normalization exposed `password=hunter2`; restoring the boundary made the regression GREEN.

## GREEN evidence

- Exact batch module gate:
  - `npm test -- tests/runtime-errors.test.ts tests/runtime-trace-flow.test.ts tests/runtime-persistence.test.ts tests/runtime-browser-redaction.test.ts tests/action-trace.test.ts tests/workflows.test.ts tests/queue.test.ts tests/mcp-permissions.test.ts`
  - 36 passed; exit 0.
- Focused implementation suite:
  - `npm test -- tests/runtime-errors.test.ts tests/runtime-trace-flow.test.ts tests/runtime-persistence.test.ts tests/runtime-browser-redaction.test.ts tests/action-trace.test.ts tests/queue.test.ts tests/workflows.test.ts tests/mcp-permissions.test.ts tests/manifest-resume-routes.test.ts`
  - 39 passed; exit 0.
- TypeScript:
  - `npm run build`
  - exit 0.
- Whitespace:
  - `git diff --check`
  - exit 0.

## Behavior and invariants

- Queue phase IDs, delays, attempts, backoff, action keys, argument hashes, deduplication, approval semantics, and legacy `tools.kind='mcp'` behavior are unchanged.
- Queue trace identity is a final argument, preserving existing positional phase/delay semantics.
- Database trace rows are authoritative. Mismatched job traces fail with `TRACE_CONTEXT_MISMATCH`; jobs without a trace can only continue from a valid authoritative row.
- Production `ExecutionContext` requires an exact manifest; test context is explicitly `{ mode: 'test', manifest: null }` and retains live-draft behavior.
- `AbortController.signal` is non-aborted in this batch; cancellation will replace it later.
- Browser task/workflow/MCP surfaces revalidate and redact both new structured errors and historical plain error fields.
- Retry decisions were not changed. Existing workflow/queue retry behavior remains for Batch 2b.

## Files

- `src/db/migrations/031_runtime_trust.sql`
- `src/runtime/trace.ts`
- `src/runtime/errors.ts`
- `src/queue/task-queue.ts`
- `src/routes/tasks.ts`
- `src/routes/workflows.ts`
- `src/routes/agent-solutions.ts`
- `src/routes/action-authorizations.ts`
- `src/routes/workflow-actions.ts`
- `src/routes/mcp/tool-calls.ts`
- `src/worker.ts`
- `src/workflows/runtime.ts`
- `src/workflows/adapters/types.ts`
- `src/workflows/adapters/agent.ts`
- `src/workflows/adapters/api.ts`
- `src/workflows/adapters/mcp.ts`
- `src/workflows/adapters/legacy-tool.ts`
- `src/policy/action-gateway.ts`
- `src/mcp/runtime.ts`
- `src/mcp/checkpoints.ts`
- `tests/runtime-errors.test.ts`
- `tests/runtime-trace-flow.test.ts`
- `tests/runtime-persistence.test.ts`
- `tests/runtime-browser-redaction.test.ts`
- `tests/action-trace.test.ts`
- `tests/queue.test.ts`

## Concerns

- Migration 031 requires the coordinator-owned PostgreSQL integration/idempotency run before merge.
- Historical rows may have null trace columns; new execution subjects and events fail closed or use a valid authoritative trace, while read-only browser normalization remains backward compatible.
