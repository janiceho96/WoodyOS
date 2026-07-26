# Departments and Runtime Program Roadmap

> **For agentic workers:** Execute the linked plans in order. Each plan is independently deployable and must pass its own verification gate before the next begins.

**Goal:** Deliver separate MCP/API Tool experiences, an editable Department org chart, and the runtime trust foundations required for future Department delegation.

**Architecture:** Preserve the existing MCP, API Tool, workflow, and policy domains. Add Departments as an organizational read/write domain that links to existing agents, then harden execution through immutable agent versions, complete manifests, tracing, structured errors, cancellation, and leases. Add governed memory and evaluation only after the execution identity model is stable.

**Tech Stack:** React 19, React Router 7, TanStack Query, React Flow, Fastify 5, PostgreSQL, BullMQ/Redis, TypeScript, Vitest.

## Global Constraints

- Do not edit, rename, move, or delete files under `sources/`.
- Preserve the original `web/` application and port 3000.
- Implement frontend work only in `web-stitch/` on port 3002.
- Never expose credentials, secrets, hidden agent instructions, raw memory, or server-only tool configuration to the browser.
- All consequential API and MCP actions continue through the shared action-policy gateway.
- Existing published workflows must continue to run.
- Production execution uses immutable published versions; draft-only execution is visibly marked as test mode.
- Department delegation is excluded from this program.

## Ordered Plans

1. [MCP and API Tools Separation](./2026-07-26-mcp-api-tools-separation.md)
   - Separates primary navigation, pages, terminology, search results, and agent-resource presentation.
   - No database migration.

2. [Department Organization](./2026-07-26-department-organization.md)
   - Adds Department storage, compatibility migration, APIs, permissions, and the hybrid org-chart UI.
   - No Department-level execution.

3. [Runtime Trust Foundations](./2026-07-26-runtime-trust-foundations.md)
   - Adds immutable agent versions, complete execution manifests, trace context, structured errors, retry classification, cancellation propagation, and worker leases.

4. [Quality, Memory, and Evaluation](./2026-07-26-quality-memory-evaluation.md)
   - Adds output-linked quality history, governed memory metadata and ranking, dry-run validation, regression cases, and replay-ready evaluation records.

## Program Gates

- Plan 1 may deploy independently.
- Plan 2 may begin after Plan 1 contracts are stable, but it does not depend on runtime changes.
- Plan 3 must complete before any proposal for Department delegation.
- Plan 4 depends on the version and trace identities introduced in Plan 3.
- A separate design review is required before Department goals or manager-led delegation are implemented.

## Program Verification

Run after every plan:

```bash
npm run build
npm test
npm --prefix web-stitch run build
npm --prefix web-stitch run lint
```

Run database-backed integration tests when Docker/PostgreSQL are available:

```bash
npm test -- tests/database.integration.test.ts
```

Do not claim live readiness until the Stitch Edition is rebuilt and verified at desktop, laptop, tablet, and mobile widths.
