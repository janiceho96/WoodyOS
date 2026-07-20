# Codex Working Context

Purpose: a short, authoritative orientation file for AI-assisted work on Woody. Read this first, then read only the linked context files relevant to the requested change. It reduces repeated repository scans and avoids spending context on stale chat history.

## Product and repository

- Product: **Woody**, an agent-workflow operating system.
- Repository: `/Users/macjanice/Documents/New project`
- Original frontend: `web/` on port `3000` — preserve it.
- Stitch frontend: `web-stitch/` on port `3002` — primary redesign surface.
- Backend: Fastify/Postgres/Redis; do not expose credentials.
- Branch: `codex/stitch-second-app`; safe checkpoint: `a35ee73`.
- `sources/` is synced reference material and read-only.

## Product outcome

The main journey is:

`Describe goal → review proposed team/resources/workflow/permissions/usage → save draft → test → publish → run → monitor → review/download output`

Woody should feel like directing a capable team. Prefer plain language, progressive disclosure, one clear primary action, honest states, and least privilege.

## Non-negotiables

- Keep working backend APIs, security controls, onboarding, and existing routes intact.
- Never create fake buttons, fake integrations, fake search, or unsupported browser/tool actions.
- Never commit or print real `.env` values, tokens, or credentials.
- Use safe data references such as `{{ input.topic }}`; never arbitrary JavaScript expressions in workflow mapping.
- Confirm destructive or external write actions explicitly.
- Preserve accessibility, mobile behavior, and both light and dark modes.
- Before a major architecture change, propose the better approach, explain trade-offs, and wait for approval.

## Current verified state (2026-07-20)

Implemented in source:

- Grouped Stitch shell and goal-first Home dashboard.
- Guided five-step Agent Builder with draft/publish distinction.
- Task-focused Runs monitor with real output, artifacts, filters, and recovery guidance.
- Knowledge Hub upload, processing, retrieval tests, document/chunk inspection.
- Application-first Integrations plus advanced MCP connection management.
- Existing workflow runtime: graph snapshots, branches, bounded loops, approvals, retries, events, artifacts, and usage/cost limits.
- Workflow foundation: registry/catalogs, separate layout persistence, modular adapters, action-bound authorization, React Flow canvas, safe mapping controls, node-path tests, and immutable draft/test/publish/production lifecycle.

Known gaps:

- No safe browser runtime/node.
- No historical-run replay or unified task/workflow Runs index.
- Known app logos are not yet rendered on workflow canvas nodes.
- Knowledge is workspace-wide; no per-agent/collection permission model.
- Migrations 019–022, Docker-backed integration tests, and live canvas visual checks remain pending because Docker was unavailable to this Codex environment.

## Workflow architecture direction

Implemented architecture:

1. Server-side node registry: canonical node metadata, config validation, input/output contracts, risk, required permissions, availability, and executor adapter.
2. Modular adapters: Agent, API/Tool, MCP, Knowledge, Logic, File. Direct MCP nodes must use a selected agent's existing allowlist and permission level. External actions pass through one action-bound policy gateway keyed to the resolved argument hash. Add Browser only after a safe runtime exists.
3. Keep executable graph (`nodes`, `edges`, version) separate from editor layout (`position`, viewport, UI state).
4. Expose a sanitized static node catalog plus a separate workspace-scoped resource catalog; never include credentials in workflow JSON or catalog responses.
5. The editor is a real React Flow canvas with typed handles, validation, undo/redo, full-screen, data mapping, and permission/cost preview.
6. Draft revision tests and immutable publish versions protect production automation; historical input replay remains future work.

Current decision status:

- MCP/API adapters: approved.
- Node registry, separate layout, workflow draft/publish, and central policy gateway: approved and implemented in source.
- Unified Runs index: proposed; seek approval before its backend change.

## High-value files

Read only what applies:

| Work | Start with |
| --- | --- |
| Overall state | `docs/context/CURRENT_STATE.md` |
| Active UX implementation | `docs/context/UX_REDESIGN_EXECUTION.md` |
| Workflow work | `docs/context/WORKFLOW_PRODUCT_SPEC.md`, `docs/context/SECURITY_AND_TRUST.md`, `docs/context/ARCHITECTURE_DECISIONS.md` |
| UI work | `docs/context/UX_DESIGN_SYSTEM.md` |
| Completion review | `docs/context/ACCEPTANCE_CRITERIA.md` |
| Product benchmarks | `docs/context/PRODUCT_BENCHMARKS.md`, `docs/context/DO_NOT_COPY.md` |

## Verification baseline

For a frontend change:

```bash
cd web-stitch
npm run build
npm run lint
```

For backend contract/runtime changes:

```bash
npm run build
npm test -- --run
```

Docker visual verification must be performed locally when Docker access is unavailable to Codex:

```bash
cd "/Users/macjanice/Documents/New project"
docker compose up --build -d
```

Do not claim visual or Docker verification unless it actually ran.

## How this saves tokens

This file is not sent to the running app and does not change user/API token use. It saves AI coding context by replacing repeated broad scans and long chat recaps with a small, stable starting point. Keep it factual and concise; update it only after verified architectural or product-state changes.
