# Phase 3 Batch 3a Report: Cooperative Distributed Cancellation

## Outcome

Implemented cooperative, authoritative cancellation for agent tasks and workflow runs. Cancellation requests are tenant-scoped, idempotent, trace-linked, and resolve pending approvals and confirmations. Active workers poll authoritative state, propagate one cancellation signal through AI, API, MCP, knowledge, file, and artifact boundaries, and finalize as either `cancelled` or `cancelled_with_side_effects`.

Action authorization and execution claims now atomically require an active task or workflow. Workflow status transitions also require the run to remain active, preventing a late completion, retry, or failure write from overwriting a concurrent cancellation request.

## RED evidence

- `npm test -- tests/runtime-cancellation.test.ts tests/action-cancellation-safety.test.ts`
  - Failed because the cancellation runtime did not exist and action authorization/claim transitions lacked cancellation guards.
- `npm test -- tests/cancellation-routes.test.ts tests/mcp-streamable-http.test.ts tests/tools-validation.test.ts`
  - Failed because cancellation routes returned the old behavior and caller signals did not reach tool or MCP transport requests.
- `npm test -- tests/action-retry-safety.test.ts tests/mcp-cancellation-signal.test.ts`
  - Failed because API and MCP execution received no caller cancellation signal.
- `npm test -- tests/workflow-cancellation.test.ts tests/worker-cancellation.test.ts`
  - Failed because queued cancellation was not finalized and workflow/AI execution replaced or omitted the caller signal.

Each failure was the expected missing behavior before its minimal production change.

## GREEN evidence

- Directly affected cancellation and propagation suite:
  - `npm test -- tests/runtime-cancellation.test.ts tests/action-cancellation-safety.test.ts tests/cancellation-routes.test.ts tests/worker-cancellation.test.ts tests/workflow-cancellation.test.ts tests/action-retry-safety.test.ts tests/mcp-cancellation-signal.test.ts tests/mcp-streamable-http.test.ts tests/tools-validation.test.ts tests/action-trace.test.ts tests/task-action-retry-safety.test.ts tests/knowledge-trace.test.ts tests/artifacts.test.ts tests/files.test.ts tests/checkpoint-redaction.test.ts tests/workflows.test.ts`
  - 56 passed; exit 0.
- Exact final Batch 3a module gate:
  - `npm test -- tests/runtime-cancellation.test.ts tests/runtime-errors.test.ts tests/workflows.test.ts tests/mcp-streamable-http.test.ts tests/tools-validation.test.ts tests/queue.test.ts tests/cancellation-routes.test.ts tests/worker-cancellation.test.ts tests/workflow-cancellation.test.ts tests/action-cancellation-safety.test.ts tests/action-retry-safety.test.ts tests/mcp-cancellation-signal.test.ts tests/checkpoint-redaction.test.ts tests/task-action-retry-safety.test.ts tests/action-trace.test.ts tests/knowledge-trace.test.ts tests/artifacts.test.ts tests/files.test.ts`
  - 18 test files and 80 tests passed; exit 0.
- TypeScript:
  - `npm run build`
  - exit 0.
- Whitespace:
  - `git diff --check`
  - exit 0.

## Files

- Cancellation authority: `src/runtime/cancellation.ts`, task/workflow routes, worker, workflow runtime.
- Action and approval safety: action gateway, MCP checkpoints, workflow approval adapter.
- Propagation boundaries: AI worker calls, tools, MCP runtime/transports, workflow adapters, knowledge retrieval, file context/service, artifact service.
- Tests: cancellation runtime, routes, worker/workflow behavior, action safety, API/MCP/tool propagation, checkpoint redaction, and the existing directly affected regression suites.

## Preserved behavior

- Trace authority, structured runtime errors, retry policy, action identity, argument hashes, deduplication, confirmation, and completion semantics remain intact.
- Cancellation is never retried and does not introduce a second retry authority.
- No execution leases or approval-expiry behavior was added.
- Migration `031_runtime_trust.sql` was not changed.

## Residual risks

- Worker observation is cooperative and polling-based, with up to the configured 500 ms default observation delay between authoritative state checks.
- In-flight third-party operations can only stop as promptly as their SDK or transport honors `AbortSignal`.
- Finalization deliberately chooses `cancelled_with_side_effects` when the action ledger indicates a consumed/executing or uncertain outcome; external side effects are not rolled back.
- No full suite or database integration was run by instruction. The focused module gate and TypeScript build are green.
