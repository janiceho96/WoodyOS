# Phase 3 Batch 3a Correction Report

## Outcome

Closed the five source-verified Important findings without adding leases, approval expiry, migrations, or retry-policy changes.

1. Task and workflow cancellation routes now enqueue deterministic finalizer jobs using authoritative trace IDs. Workflow cancellation also enqueues affected child tasks.
2. Native workflow approval decisions now lock tenant-qualified run and approval rows, validate active awaiting state, commit approval and run transitions atomically, and enqueue only after commit. Queue compensation restores waiting state only while the run remains authoritatively queued.
3. Task and workflow failure paths use guarded status transitions and authoritative state checks. If cancellation wins before the local poll signal observes it, workers conservatively finalize cancellation instead of overwriting it with failure.
4. Internal web and job tools preserve the caller signal through dispatch and provider adapters. The shared pinned HTTP helper combines it with the request timeout.
5. Write-capable legacy workflow tools now use the shared action authorization ledger with the existing API adapter identity, real risk classification, stable argument hash, trace context, and begin/complete/fail lifecycle. An exact directly preceding completed approval node and loop iteration satisfies confirmation without a redundant prompt.

## TDD evidence

- Cancellation finalizer enqueue:
  - RED: `npm test -- tests/cancellation-routes.test.ts`
  - 2 failed because neither route enqueued a finalizer.
  - GREEN: 2 passed.
- Native approval race:
  - RED: `npm test -- tests/workflow-approval-cancellation-race.test.ts`
  - 3 failed because there were no locks/transaction, cancellation was overwritten, and compensation restored waiting state after cancellation.
  - GREEN with cancellation routes: 2 files and 5 tests passed.
- Worker error-versus-cancel race:
  - RED: `npm test -- tests/worker-cancellation.test.ts`
  - 2 failed and 2 passed; task provider and workflow manifest errors rejected after cancellation won.
  - GREEN: 4 passed.
- Internal web/job active abort:
  - RED: `npm test -- tests/internal-tool-cancellation.test.ts`
  - 2 failed with both request signals undefined.
  - GREEN with existing web/job regressions: 5 files and 25 tests passed.
- Legacy action ledger:
  - RED: `npm test -- tests/legacy-action-ledger.test.ts`
  - 2 failed because no ledger row existed and an uncertain cancellation finalized false-clean.
  - GREEN with action safety/retry/trace regressions: 4 files and 8 tests passed.

## Final gate

- Expanded Batch 3a module suite:
  - `npm test -- tests/runtime-cancellation.test.ts tests/runtime-errors.test.ts tests/workflows.test.ts tests/mcp-streamable-http.test.ts tests/tools-validation.test.ts tests/queue.test.ts tests/cancellation-routes.test.ts tests/worker-cancellation.test.ts tests/workflow-cancellation.test.ts tests/action-cancellation-safety.test.ts tests/action-retry-safety.test.ts tests/mcp-cancellation-signal.test.ts tests/checkpoint-redaction.test.ts tests/task-action-retry-safety.test.ts tests/action-trace.test.ts tests/knowledge-trace.test.ts tests/artifacts.test.ts tests/files.test.ts tests/workflow-approval-cancellation-race.test.ts tests/internal-tool-cancellation.test.ts tests/legacy-action-ledger.test.ts tests/web-provider-adapters.test.ts tests/web-research.test.ts tests/job-search.test.ts tests/manifest-resume-routes.test.ts`
  - 25 test files and 112 tests passed; exit 0.
- TypeScript:
  - `npm run build`
  - exit 0.
- Whitespace:
  - `git diff --check`
  - exit 0.

## Self-review

- Cancellation requests and approval decisions use workspace-qualified authoritative rows.
- Cancellation queue job phase IDs remain deterministic, so repeated cancellation does not multiply logical jobs.
- Approval enqueue happens only after commit. Compensation locks and checks the expected queued state before restoring approval/run state.
- Failure updates exclude cancellation states through exact expected-state predicates and inspect `RETURNING` before persisting dependent failure artifacts/events.
- The legacy approval bypass is not exposed to standalone task authorization. It is a workflow-only internal marker supplied after the legacy adapter verifies the exact preceding approval node and iteration.
- The legacy adapter uses `adapter='api'` because the existing database constraint permits `api`, `mcp`, and `browser`; no schema expansion was introduced.
- Migration `031_runtime_trust.sql` remains unchanged.

## Remaining risks

- No full suite or database integration was run by instruction.
- BullMQ idempotence depends on the existing deterministic hashed phase IDs and retained completed/failed job records.
- Third-party cancellation responsiveness still depends on provider support for `AbortSignal`.
- Minor, deferred by instruction: the fallback implementation in `combineAbortSignals` does not remove listeners from non-winning signals after one signal aborts.
