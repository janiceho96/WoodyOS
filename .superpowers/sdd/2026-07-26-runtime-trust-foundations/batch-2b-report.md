# Phase 3 Batch 2b Report: Retry Authority Without Multiplication

## Outcome

Implemented one logical retry authority for workflow nodes. `retryDecision` consumes Batch 2a structured runtime errors plus the persisted node retry policy and current attempt. Workflow node state and events persist the redacted structured error and decision before scheduling at most one next logical attempt.

BullMQ task and workflow queues now deliver each logical phase once. Knowledge ingestion, file processing, and artifact generation retain their existing three delivery attempts as the separately approved safe-reentry class.

## Retry rules

- Cancellation, authentication, validation, policy denial, permanent, and unknown errors never retry.
- Rate limits honor finite nonnegative `retryAfterMs`, bounded by the node policy maximum delay.
- Transient and timeout errors retry only when the normalized error, node definition, policy, and remaining attempt budget all allow it.
- Infrastructure errors require explicit `allowInfrastructureRetry` classification and remain bounded by the node policy.
- A structured error's `retryable: false` is always a veto; `retryable: true` never overrides category or action safety.
- Write, external-write, destructive, and unknown-risk actions never automatically retry.
- Failures after a non-read external action begins are persisted and propagated as `ACTION_OUTCOME_UNCERTAIN`, category `permanent`, with `retryable: false`.
- Standalone agent tasks have no new logical retry loop.

## RED evidence

- `npm test -- tests/runtime-errors.test.ts tests/workflow-retry.test.ts tests/queue.test.ts`
  - 15 failed; 10 passed.
  - Pure retry cases failed because `retryDecision` and `uncertainActionOutcome` did not exist.
  - Queue authority failed because runtime/safe-reentry option builders did not exist.
  - Workflow persistence failed because the node stored only the structured error, without its retry decision.
- `npm test -- tests/runtime-errors.test.ts -t "bounds rate-limit"`
  - Failed because a non-finite `retryAfterMs` produced `NaN` instead of the policy delay.
- `npm test -- tests/action-retry-safety.test.ts`
  - Failed because an uncertain write outcome propagated as a plain `unknown` error instead of `ACTION_OUTCOME_UNCERTAIN`.

Each failure was the expected missing behavior before its minimal production change.

## GREEN evidence

- Initial focused retry suite:
  - `npm test -- tests/runtime-errors.test.ts tests/workflow-retry.test.ts tests/queue.test.ts`
  - 25 passed; exit 0.
- Non-finite rate-limit edge:
  - `npm test -- tests/runtime-errors.test.ts -t "bounds rate-limit"`
  - 1 passed; 19 skipped; exit 0.
- Action uncertainty boundary:
  - `npm test -- tests/action-retry-safety.test.ts`
  - 1 passed; exit 0.
- Exact Batch 2b module gate:
  - `npm test -- tests/runtime-errors.test.ts tests/workflows.test.ts tests/queue.test.ts tests/mcp-permissions.test.ts tests/workflow-retry.test.ts tests/action-retry-safety.test.ts`
  - 50 passed; exit 0.
- TypeScript:
  - `npm run build`
  - exit 0.
- Whitespace:
  - `git diff --check`
  - exit 0.

## Files

- `src/runtime/errors.ts`
- `src/workflows/runtime.ts`
- `src/queue/task-queue.ts`
- `src/worker.ts`
- `src/workflows/adapters/api.ts`
- `src/workflows/adapters/mcp.ts`
- `src/workflows/adapters/legacy-tool.ts`
- `tests/runtime-errors.test.ts`
- `tests/workflow-retry.test.ts`
- `tests/action-retry-safety.test.ts`
- `tests/queue.test.ts`

## Preserved behavior

- Existing workflow retry fields and limits are unchanged.
- Trace validation is unchanged.
- Action authorization IDs, argument hashes, deduplication, confirmation, claim, completion, and failure transitions are unchanged.
- Queue phase IDs and delays remain deterministic.
- Knowledge, file, and artifact safe-reentry attempts remain three.
- Cancellation, execution leases, and approval expiration remain future batches.

## Residual risks

- This batch does not classify plain third-party exceptions into transient categories. Producers must emit an approved structured category before a workflow retry is eligible; plain errors normalize to non-retryable `unknown`.
- No full suite or database integration was run by instruction. This batch has no migration.
