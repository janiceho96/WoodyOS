# Current State

Last verified: 2026-07-23.

## Working

- Phase 1 UX foundation: grouped seven-item navigation, goal-first dashboard, contextual Templates/MCP entry points, Runs terminology, live-work indicator, and direct dashboard-to-Prompt-to-Agent handoff.
- Guided Agent Builder: five-step Purpose, Instructions, Resources, Model, and Review flow with progressive model controls, explicit least-access permissions, live summary, draft/publish distinction, and responsive navigation.
- Runs task monitor: search/status/agent/date filters; clear input, events, output, artifact, cost, and status-specific recovery presentation. It remains task-only until the proposed unified execution index is approved.
- Knowledge Hub: real drag/drop upload, processing visibility, workspace-scope explanation, retrieval testing, document inspection, extracted-text preview, and chunk preview via `GET /v1/knowledge/documents/:id`.
- Integrations: application-first Connected/App catalog/Custom API experience that summarizes real custom APIs and MCP applications; advanced MCP keeps tool discovery, OAuth, health, agent access, allowlists, and activity.
- Safe demo APIs: server-owned, one-click read-only starters for Open-Meteo weather, Open Library book search, and Frankfurter reference exchange rates. They require no key, expose no endpoint configuration to the frontend, and include agent-ready schemas and sample prompts.
- Web research runtime: provider-independent Tavily, Brave, and user-controlled SearXNG search adapters; a separate SSRF-protected public HTTPS page reader; and a dedicated Reddit OAuth search adapter. All three are read-only, independently assignable per agent, credential-safe, bounded, and returned to the model as untrusted evidence with citation instructions.
- Web research UX: Integrations has a deep-linkable Web Research section for secure provider configuration and health checks. Agent Builder requires both Web access and an explicitly selected tool; research starter solutions disclose when current-source access is disconnected or unassigned.
- Authentication, onboarding, dashboard, agents, queued tasks, and task output viewing.
- Markdown output viewing plus generated PDF, DOCX, PPTX, and XLSX artifacts.
- Knowledge upload, extraction, chunking, full-text search, and optional vector search.
- MCP Marketplace: Streamable HTTP connections, encrypted credentials, discovery, allowlists, permissions, health, logs, and agent assignment.
- Workflow execution: snapshots, branches, retries, bounded loops, approval, node traces, artifacts, and cost/usage limits.
- Workflow foundation: server-owned node registry and sanitized palette, workspace-scoped resource catalog, separate editor layout storage, modular Agent/API/MCP/Knowledge/Logic/File adapters, exact action-bound confirmations, and redacted tool-call audit data.
- Shared action-policy gateway: workflow and agent-task API/MCP actions use one argument-bound authorization model. Read actions run automatically; every write-capable or unknown action pauses for owner/admin confirmation, is atomically claimed once, and records only redacted inputs and limited results.
- Workflow editor: real React Flow canvas with drag/drop, typed handles, visible connections, pan/zoom/minimap/fullscreen, auto-layout, undo/redo, Simple/Advanced modes, schema-driven inspector, safe mapping insertion, permission review, active-path highlighting, and node-path testing.
- Workflow lifecycle: editable numbered drafts, full-draft tests, immutable published versions, pause/resume compatibility, and production runs pinned to a published version. Node-only tests deliberately cannot unlock publishing.
- Workspace PowerPoint themes: a safe `DESIGN.md` parser, default theme selection, and theme-aware PPTX rendering with title, card, and table layouts.
- Settings: outcome-based secondary navigation for Workspace, AI Providers, Budget, Security, Presentation, Appearance, and Developer controls. Workspace-level Anthropic/OpenAI-compatible credentials are encrypted at rest, masked in responses, endpoint-restricted, testable, and loaded per run without exposing secrets to the frontend.
- Analytics: validated 1/7/30-day database aggregations for spend, reliability, daily usage, and per-agent effectiveness, plus clearly separated local budgets and provider-reported remaining allowance. Unavailable provider pricing and upstream limits are labeled rather than inferred.
- Create: Templates, prompt import, and installed drafts share one outcome-based page. Generated proposals provide a single review of editable agents, workflow, Knowledge access, suggested integrations, required permissions/approvals, expected Markdown, and token estimates; installation remains inactive until a successful real test and explicit activation.
- Curated application identity: local, non-tracking brand marks for Notion, GitHub, Linear, Stripe, Figma, Google Drive, Gmail, Google Calendar, and Obsidian are shared by Integrations and exact MCP workflow action nodes. Unknown/community servers retain a safe generated mark.

## Partial

- UX redesign: the shell, dashboard, Create, Agent Builder, Runs task view, Knowledge Hub, Integrations entry experience, workflow editor, Settings, and Analytics are substantially redesigned in source; unified Runs and the final cross-device visual audit remain.
- Workflow editor: functional visual authoring and lifecycle are implemented in source. A desktop CSS breakpoint regression that hid the production canvas styling has been corrected; laptop widths now use a closable inspector drawer instead of placing configuration below the 720px canvas, and mobile uses a full-height drawer. Upstream-only mapping, stronger inline topology feedback, a chatbot-safe page boundary, and real post-test workflow usage/cost summaries are also implemented. Docker rebuild and live desktop/mobile verification are still required.
- Shared accessibility: dialogs trap focus, restore the invoking focus, lock background scrolling, close with Escape, and use labelled dialog semantics; Create, Integrations, and MCP segmented tabs support arrow/Home/End keyboard navigation and linked tab panels; artifact icon actions have accessible names. The mobile navigation now becomes non-focusable while off-screen, has a dismissible backdrop and Escape behavior, and reports active pages with `aria-current`.
- Knowledge retrieval: workspace-wide; agent runtime currently relies on full-text retrieval.
- MCP tools in workflows: exact discovered MCP actions assigned to active agents are available, with curated application metadata and local brand marks implemented in source; live canvas verification remains pending.
- Shared action-policy gateway: backend/frontend builds, lint, and 73 non-Docker tests pass. The PostgreSQL migration and approval/resume flow still require Docker-backed integration and live UI verification because this Codex sandbox cannot access the Docker socket or localhost ports.
- Web research: backend/frontend builds and 19 focused adapter/contract tests pass, including mocked Tavily, Brave, SearXNG, page reading, and Reddit OAuth flows. The running port-3002 Docker image remains the older Integrations build and must be rebuilt locally before database-backed and live provider verification.

## Missing

- A controlled Browser runtime; Advanced mode now shows the planned Browser node as safely locked with the reason instead of hiding it.
- Full run replay from historical input; full-draft and node-path test input are implemented.
- Direct task/chat file attachments.
- Per-agent/per-collection knowledge permissions and citations.
- Unified task + workflow Runs index (ADR-level backend change still requires explicit approval).

## Constraints

- Original `web/` app and port 3000 must remain intact.
- Stitch Edition is `web-stitch/` on port 3002.
- Never print `.env` values or secrets.
- `sources/` is read-only synced reference material.
