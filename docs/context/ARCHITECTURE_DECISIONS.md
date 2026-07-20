# Architecture Decisions

## ADR-001: Server-side workflow node registry

Status: Proposed.

Use a registry for node metadata, schemas, validation, risk, and execution rather than expanding hardcoded workflow enums and runtime switches.

Trade-off: more setup now; much safer and easier expansion later.

## ADR-002: MCP is the preferred integration layer

Status: Approved.

Use MCP/API adapters rather than maintaining hundreds of native connectors. Show users exact app and operation names where known.

## ADR-003: Keep workflow definitions separate from editor layout

Status: Proposed.

Store executable graph definition separately from canvas positions, viewport, and UI state.

## ADR-004: Draft and publish are separate

Status: Proposed.

Production runs use immutable published workflow versions. Drafts may be incomplete.

## ADR-005: Central policy gateway

Status: Proposed.

All API, MCP, browser, and agent actions pass through one policy system for permissions, cost limits, confirmation, idempotency, and audit logging.
