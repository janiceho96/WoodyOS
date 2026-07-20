# Woody UX Redesign — Execution Context

Purpose: compact source of truth for continuing the approved UX redesign without rereading chat history. Read this file before UX work, then load only the page and reference files named by the current phase.

## Product outcome

Woody should feel like directing a capable team, not configuring an operating system.

Primary journey:

`Describe goal → Review proposed agents/resources/workflow/permissions/usage → Save draft → Test → Publish → Run → Monitor → Review/download output`

Organize UI around user outcomes. Keep technical detail available through progressive disclosure.

## Repository and safety checkpoint

- Root: `/Users/macjanice/Documents/New project`
- Stitch frontend: `web-stitch/`, port `3002`
- Original frontend: `web/`, port `3000` — do not break or replace
- Branch: `codex/stitch-second-app`
- GitHub: `https://github.com/janiceho96/WoodyOS`
- Pre-redesign checkpoint: `a35ee73`
- `sources/` is read-only
- Never expose or commit secrets; real `.env` files remain ignored

## Approved architecture

1. Preserve working APIs, data, security, and runtime behavior.
2. Build shared schemas, registries, adapters, resource selectors, permission summaries, validation, and recovery patterns before page-specific copies.
3. Keep executable workflow graphs separate from canvas layout/viewport state.
4. Use MCP/API adapters instead of maintaining hundreds of native connectors.
5. Show exact app/action names when known; keep protocol details advanced.
6. Use safe data references, never arbitrary JavaScript expressions.
7. Draft and publish are separate lifecycle states.
8. All consequential actions pass through permissions, confirmation, cost limits, idempotency rules, and audit logging.
9. Never add a UI control for a backend capability that does not exist.

Safe mapping examples:

```text
{{ input.topic }}
{{ nodes.research.text }}
{{ nodes.gmail.messages[0].subject }}
{{ variables.customer }}
```

## UX rules

- One obvious primary action per page.
- Beginner language first; technical details progressively disclosed.
- Never show fake Search, AI, app, browser, or action controls.
- Errors explain: what happened, what was affected/saved, next action.
- Explicit review before publishing agents/workflows.
- Explicit confirmation before destructive or external writes.
- Least privilege by default.
- Support loading, empty, error, disabled, permission, and completed states.
- Preserve keyboard navigation, labels, focus, responsive behavior, light/dark mode.
- Woody chatbot must not cover required controls.

## Information architecture

Primary navigation:

```text
Home
Build
  Agents
  Workflows
Resources
  Knowledge
  Integrations
Activity
  Runs
  Analytics
Settings
```

Contextual routes remain available:

- Agent Builder: `/agents/new`, `/agents/:id/edit`
- Create/Templates/Prompt-to-Agent: `/solutions`
- Advanced MCP: `/mcp`, entered from Integrations

## Completed in current UX changes

### Shell and Home

- Grouped seven-item navigation.
- Dashboard renamed Home; Logs renamed Runs; Tools renamed Integrations.
- Goal-first Home composer.
- Home goal passes into existing Prompt-to-Agent compiler.
- Attention/active work, recent outputs, next steps, compact metrics.
- Global active-run indicator.
- Existing routes preserved.

Files:

- `web-stitch/src/app/AppShell.tsx`
- `web-stitch/src/features/dashboard/DashboardPage.tsx`
- `web-stitch/src/features/solutions/StarterSolutionsPage.tsx`
- `web-stitch/src/features/tools/ToolsPage.tsx`
- `web-stitch/src/index.css`

### Agent Builder

- Five steps: Purpose, Instructions, Resources, Model, Review.
- Clear Save draft vs Publish agent.
- Instruction helpers, explicit access, collapsed advanced model controls.
- Live summary, validation, publish boundary, responsive step navigation.
- Existing create/update API preserved.
- Knowledge access is honestly described as workspace-wide; no fake per-document picker.

Files:

- `web-stitch/src/features/agents/AgentBuilderPage.tsx`
- `web-stitch/src/index.css`

Verification already passed after these changes:

```bash
cd web-stitch
npm run build
npm run lint
```

Lint has four pre-existing hook warnings outside the redesigned builder.

Live Docker visual verification remains required after rebuild.

## Remaining phases

### 1. Runs and recovery — next

- Implemented for agent tasks: search/status/agent/date filters; inputs, timeline, Markdown/JSON output, artifacts, usage/cost; human-readable status and failure guidance; safe Open agent action; PDF preview and file downloads.
- Not implemented: workflow filtering/unified activity. This requires ADR-006, the proposed unified execution index. Do not add a fake workflow filter.

Primary file: `web-stitch/src/features/execution/ExecutionPage.tsx`.

Architecture gate: current Runs lists agent tasks only; workflow runs are only available inside Workflow Designer. Implement ADR-006 (unified execution index) before claiming a genuine workflow filter or unified activity view.

### 2. Knowledge

- Implemented: drag/drop upload, status overview, processing/indexing/retrieval states, extraction and chunk inspection, semantic/full-text retrieval test, and explicit workspace-wide access explanation.
- Backend: `GET /v1/knowledge/documents/:id` returns authorized document detail and up to 100 indexed chunks on demand.
- Still missing: per-agent/collection assignment; do not add it until a real permission API exists.

Primary file: `web-stitch/src/features/knowledge/KnowledgePage.tsx`.

### 3. Integrations

- Implemented: main application-first Connected, App catalog, and Custom API sections; one summary for real API and MCP connections; explicit advanced MCP path; app connection review handoff.
- Existing Advanced MCP provides exact discovered tools, OAuth, health, logs, permissions, and per-agent access/allowlists.
- Protocol/transport details remain advanced.

Primary files: `web-stitch/src/features/tools/ToolsPage.tsx`, `web-stitch/src/features/mcp/`.

### 4. Workflow foundation

- Shared server-side node registry.
- Agent, MCP, API, Knowledge, Browser, Logic, File adapters.
- Typed input/output/config/risk/permission schemas.
- Credentials separate from workflow JSON.

Read `WORKFLOW_PRODUCT_SPEC.md`, `SECURITY_AND_TRUST.md`, `ARCHITECTURE_DECISIONS.md`.

### 5. Workflow canvas

- React Flow or equivalent as editor only; Woody graph remains canonical.
- Real drag/connect, typed handles, lines, pan/zoom/minimap/fullscreen.
- Undo/redo, auto-layout, simple/advanced modes.
- Exact app action nodes, data mapping, inline validation.
- Permission/cost preview, node test, sample data, active-path trace.

Primary file: `web-stitch/src/features/workflows/WorkflowsPage.tsx`.

### 6. Create/Templates

- Unify goal, templates, prompt import, installed drafts.
- Review one solution: team, workflow, knowledge, integrations, usage.
- Install inactive drafts by default.

### 7. Settings and Analytics

- Settings secondary navigation: Workspace, AI Providers, Budget, Security, Presentation, Appearance, Developer.
- Provider test, masked credentials, unsaved-change guard.
- Analytics organized around spend, reliability, effectiveness, limits.

### 8. Final audit

- Desktop/tablet/mobile; dark/light.
- Loading/empty/error/disabled/completed.
- Keyboard/screen reader/focus/contrast.
- Terminology, spacing, primary actions, chatbot overlap.

## n8n/LangGraph adaptation

Learn from n8n: node registry, visual graph, app/action language, mapping, node traces, credential separation.

Learn from LangGraph: explicit state, checkpoints, controlled loops, interruption/resume, subgraphs.

Do not copy: branding/code, huge connector burden, unrestricted expressions/code/shell, credentials in JSON, automatic retries for external writes, frontend-library-coupled storage.

Already working in backend: persisted definitions, branches, bounded loops, retries, approvals, durable state, events, artifacts, usage/cost limits, MCP permissions.

Still missing: registry, adapters, real canvas, exact app nodes, mapping UI, versions, node tests, visual path, safe browser nodes.

## Verification contract

For each phase:

1. Inspect existing frontend and backend contract.
2. Reuse shared architecture; do not duplicate patterns.
3. Implement incrementally without removing working routes/features.
4. Run frontend build and lint.
5. Run backend build/tests for contract/runtime changes.
6. Rebuild Docker when possible.
7. Visually inspect every changed page at `localhost:3002`, desktop and mobile.
8. Update `CURRENT_STATE.md`.
9. Report complete, partial, blocked, and missing work honestly.

Completion requires functional pages, enforced safety, passing relevant tests, and visual verification. Do not claim pixel match or completion from source inspection alone.

## Token-efficient loading protocol

For a UX continuation:

1. Read this file.
2. Read `CURRENT_STATE.md`.
3. Load only the current page file plus directly relevant API/types/styles.
4. For workflow work, additionally load the three workflow/security architecture documents named above.
5. Do not reread old chat transcripts, all reference HTML, or unrelated feature files unless a discovered dependency requires them.
6. Record new approved decisions here or in the dedicated context file; do not duplicate full code or logs.
