# LangGraph Copilot Orchestrator Design

**Date:** 2026-07-30  
**Status:** Approved in conversation; awaiting written-spec review  
**Scope:** Reliable contextual answers, output-refinement proposals, and Draft-agent proposals

## Goal

Replace the current single-prompt Copilot proposal generator with an embedded
LangGraph.js `StateGraph` that reliably distinguishes ordinary questions from
mutation proposals, produces schema-valid proposal candidates, and preserves
the application's existing approval and execution contracts.

The first slice must make the Refine-with-Agent experience dependable without
adding workflow graph mutation, Department changes, MCP/API permission changes,
publishing, or activation.

## Success criteria

1. A contextual question such as "is there any error?" receives a normal,
   grounded answer and does not enter proposal compilation.
2. An explicit refinement request produces either a useful clarification or a
   valid output-refinement proposal.
3. An explicit request for a new agent produces either a useful clarification
   or a valid Draft-agent proposal.
4. Invalid model output receives at most one bounded repair attempt.
5. Invalid or unrepaired output creates no proposal and causes no mutation.
6. Existing approval, idempotency, output versioning, Draft-agent creation,
   auditing, and execution receipts remain authoritative.
7. Repeated attachment citations are deduplicated by file and locator before
   they are returned to the UI.
8. Provider failures preserve the conversation and attached context for retry.

## Architecture decision

Use `@langchain/langgraph` and `@langchain/core` inside the existing TypeScript
API. Do not introduce a Python service or a separate LangGraph Agent Server for
this slice.

Build one Copilot Orchestrator graph with specialized nodes. Do not create a
fleet of autonomous agents. Deterministic nodes own routing, validation, retry
limits, and persistence boundaries; model-backed nodes are limited to answering,
clarifying, proposal generation, and one schema repair.

The existing PostgreSQL chat, context snapshot, proposal, approval, receipt,
and audit records remain the system of record. The initial graph is invoked once
per turn and reloads its bounded state from those records. A LangGraph
checkpointer is intentionally deferred to avoid duplicating conversation and
proposal state.

## Graph

```text
START
  -> load_context
  -> route_intent
       -> answer_question -----------\
       -> ask_clarification ----------+-> finalize_turn -> END
       -> compile_refinement -> validate_candidate
       -> compile_draft_agent -> validate_candidate
       -> unsupported ---------------/

validate_candidate
  -> persist_proposal -> finalize_turn -> END
  -> repair_candidate -> validate_repair

validate_repair
  -> persist_proposal -> finalize_turn -> END
  -> schema_failure -> finalize_turn -> END
```

Approval and application occur after the graph ends through the existing
proposal endpoints. The graph may create a reviewable proposal, but it cannot
approve or apply one.

## Typed graph state

The graph state contains:

- `workspaceId`, `actorId`, and `threadId`;
- `contextSnapshotId`;
- the bounded typed context snapshot;
- the selected output content and immutable output-version identity;
- recent bounded conversation messages;
- deduplicated attachment evidence;
- `intent`;
- clarification questions, answer content, or proposal candidate;
- proposal kind and persisted proposal ID;
- validation issues represented only as safe field paths and error codes;
- repair count, limited to zero or one;
- the final typed Copilot event;
- request and trace identifiers.

The graph state must not contain decrypted credentials. Raw provider responses
must not be written to logs, audit metadata, chat metadata, or graph state after
the turn completes.

## Intent contract

Supported intents:

- `answer_question`
- `refine_output`
- `create_draft_agent`
- `clarify`
- `unsupported`

Routing uses deterministic rules first:

- questions about the selected output, errors, context, citations, or how the
  feature works route to `answer_question`;
- explicit edit, rewrite, improve, shorten, expand, or refine instructions route
  to `refine_output`;
- explicit create/add/request-agent instructions route to
  `create_draft_agent`;
- replies to an outstanding clarification resume its recorded proposal kind;
- explicitly deferred operations route to `unsupported`.

An inexpensive structured model classification is used only when deterministic
rules cannot identify the intent confidently. The classifier must return one of
the supported intent values and may not create a proposal.

## Model-backed nodes

### Answer question

Produces a concise grounded answer using the selected context and attachment
evidence. It returns a `message` event, never a proposal candidate.

### Ask clarification

Returns one to three short questions using the existing clarification contract.
Clarification rounds remain limited by the existing policy.

### Compile refinement

Returns:

- `proposedContent`;
- one to twenty concise `changeSummary` items.

Immutable document, version, and content-hash fields are supplied by application
code after validation, not generated by the model.

### Compile Draft agent

Returns the editable Draft-agent fields. Application code normalizes safety
fields so the result always has:

- `status: "draft"`;
- no tool IDs;
- web browsing disabled;
- code interpretation disabled.

### Repair candidate

Receives only:

- the candidate object;
- the expected proposal kind;
- safe validation issue paths and codes;
- the relevant output schema.

It does not receive the full conversation, attachment extracts, or unrelated
workspace context. It runs at most once.

## Structured output and validation

All graph boundaries use Zod schemas. Provider-native structured output may be
used when the configured OpenAI-compatible provider supports it, but correctness
must not depend on that capability.

The fallback parser accepts a single JSON object, optionally surrounded by one
Markdown JSON fence. Prose surrounding the object is invalid.

Validation sequence:

1. Parse the provider result.
2. Validate the generated-turn schema.
3. Normalize the candidate through the existing proposal contracts.
4. If invalid and repair count is zero, run `repair_candidate`.
5. Validate the repaired result.
6. Persist only a valid normalized proposal.

An invalid final result returns `COPILOT_PROPOSAL_SCHEMA_INVALID` with a request
ID and retry action. It creates no `copilot_proposals` row.

## Existing service boundaries

LangGraph calls the existing domain seams:

- context loading and context snapshot views;
- `createCopilotProposal`;
- proposal approval and rejection;
- output-version creation;
- Draft-agent creation;
- audit insertion;
- execution-receipt creation.

The graph does not write output versions, agents, approvals, receipts, or audit
events directly. It does not bypass workspace, actor, role, expiration,
idempotency, or stale-version checks.

## Error handling and observability

Return specific safe errors:

- `COPILOT_INTENT_CLASSIFICATION_FAILED`
- `COPILOT_PROPOSAL_SCHEMA_INVALID`
- `COPILOT_PROVIDER_FAILED`
- existing stale-context, authorization, expiration, and idempotency codes

For each turn, log:

- request and trace IDs;
- thread and context snapshot IDs;
- selected graph path;
- provider and model;
- latency and token usage by model-backed node;
- validation issue codes and paths;
- repair attempted/succeeded flags;
- resulting proposal or event type.

Do not log raw model responses, output content, attachment extracts, API keys,
credentials, or user document passages.

Provider failure and schema failure preserve the user's message, thread, and
context snapshot so a retry does not require reopening the output.

## Citation behavior

Retrieval may use multiple chunks from one page, but the returned citation list
is deduplicated by:

```text
fileId + locator
```

When multiple chunks share a citation identity, retain the highest score. Preserve
distinct locators from the same file. Citation deduplication changes display
metadata only; model grounding may still use several bounded chunks.

## Token and latency controls

- Use deterministic intent rules before model classification.
- Bound recent conversation history and attachment characters using the existing
  limits.
- Do not send attachment extracts to the repair node.
- Permit one repair call only.
- Do not run answer and proposal branches in parallel.
- Record token usage per node.
- Keep proposal schemas compact and exclude application-owned immutable fields
  from model generation.

The ordinary successful paths require one model call. Ambiguous intent or an
invalid candidate may require one additional call. The edge case combining
ambiguous intent, proposal generation, and an invalid candidate may require a
third repair call. A turn may never exceed three model calls in this slice.

## Testing

### Unit tests

- deterministic routing for each intent;
- ambiguous-intent classifier contract;
- typed graph state transitions;
- normal questions never reach proposal nodes;
- refinement and Draft-agent compilation;
- clarification routing and round limit;
- initial validation success;
- repair success;
- repair failure after one attempt;
- unsupported-operation routing;
- citation deduplication;
- safe diagnostic construction.

### Integration tests

- contextual question through the chat endpoint;
- refinement proposal persistence;
- Draft-agent proposal persistence;
- invalid provider output creates no proposal;
- approval remains idempotent;
- stale output versions are rejected;
- output-version and Draft-agent receipts remain correct;
- provider failure preserves conversation and context;
- workspace and actor isolation.

### UI tests

- ordinary answer card;
- clarification card;
- refinement preview;
- Draft-agent proposal;
- schema-error retry action;
- deduplicated source list;
- approval and receipt rendering;
- output context remains attached after a recoverable failure.

### Live verification

Using a temporary workspace and completed output:

1. Open Refine with Woody.
2. Ask an ordinary diagnostic question and verify an answer.
3. Request a refinement and verify a reviewable proposal.
4. Approve it and verify a new output version and receipt.
5. Request a new agent and verify a Draft-agent proposal.
6. Approve it and verify a Draft agent and receipt.
7. Verify temporary verification data is removed.

## Rollout

1. Add the LangGraph.js dependencies.
2. Introduce the typed graph behind the current orchestrator interface.
3. Run existing and new tests against both implementations.
4. Enable the graph for development and the local deployed app.
5. Remove the legacy single-prompt generator after parity verification.

No runtime feature flag is required after local parity is proven because this is
not a public multi-tenant deployment. The old generator remains in version
control for rollback.

## Deferred work

- workflow graph mutation;
- Department changes;
- MCP connections;
- API tool and permission changes;
- agent activation or publishing;
- workflow publishing or activation;
- standing authority;
- LangGraph checkpointer or Agent Server;
- cross-thread long-term memory;
- LangSmith or another hosted tracing dependency.

## Acceptance criteria

The design is complete when:

1. The embedded LangGraph.js graph replaces proposal-only routing.
2. Contextual questions reliably return normal answers.
3. Refinement and Draft-agent requests produce valid reviewable proposals.
4. Invalid output is repaired once or returns a specific safe diagnostic.
5. No invalid output causes a proposal or mutation.
6. Existing approvals, domain mutations, audits, and receipts remain unchanged.
7. Duplicate page citations are removed.
8. Focused unit, integration, UI, build, and live verification checks pass.

## References

- LangGraph.js overview: https://docs.langchain.com/oss/javascript/langgraph/overview
- LangGraph.js persistence: https://docs.langchain.com/oss/javascript/langgraph/persistence
- LangGraph.js interrupts: https://docs.langchain.com/oss/javascript/langgraph/interrupts
