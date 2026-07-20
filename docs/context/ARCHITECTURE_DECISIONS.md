# Architecture Decisions

## ADR-001: Server-side workflow node registry

Status: Approved and implemented in source. Database integration verification pending.

Use a registry for node metadata, schemas, validation, risk, and execution rather than expanding hardcoded workflow enums and runtime switches.

Trade-off: more setup now; much safer and easier expansion later.

## ADR-002: MCP is the preferred integration layer

Status: Approved.

Use MCP/API adapters rather than maintaining hundreds of native connectors. Show users exact app and operation names where known.

## ADR-003: Keep workflow definitions separate from editor layout

Status: Approved and implemented in source. Database integration verification pending.

Store executable graph definition separately from canvas positions, viewport, and UI state.

## ADR-004: Draft and publish are separate

Status: Approved and implemented in source. Database integration verification pending.

Production runs use immutable published workflow versions. Drafts may be incomplete.

## ADR-005: Central policy gateway

Status: Approved and implemented in source. Database integration verification pending.

All API, MCP, browser, and agent actions pass through one policy system for permissions, cost limits, confirmation, idempotency, and audit logging.

External calls atomically move from `approved` to `executing` before transport invocation. If a worker dies after the remote side effect but before recording completion, the same action attempt stops as uncertain instead of automatically repeating a potentially non-idempotent write. Full recovery results are encrypted; frontend audit views receive only redacted summaries.

## ADR-006: Unified execution index for Runs

Status: Proposed.

Expose a workspace-scoped read-only Runs API that normalizes agent tasks and workflow runs into one lightweight list record. Keep task and workflow-run detail endpoints separate and authoritative.

The list record should include: `kind`, `id`, `title`, `status`, `agent/workflow identity`, timestamps, duration, usage/cost summary, and whether an approval or error needs attention. It must not expose workflow state, credentials, or full output in the list response.

Trade-off: one additional query/normalization layer now. In return, the Runs page can truthfully filter across agent and workflow work, provide one activity view, and avoid duplicating monitoring UI in the Workflow Designer.
