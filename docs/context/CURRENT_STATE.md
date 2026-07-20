# Current State

Last verified: 2026-07-20.

## Working

- Phase 1 UX foundation: grouped seven-item navigation, goal-first dashboard, contextual Templates/MCP entry points, Runs terminology, live-work indicator, and direct dashboard-to-Prompt-to-Agent handoff.
- Guided Agent Builder: five-step Purpose, Instructions, Resources, Model, and Review flow with progressive model controls, explicit least-access permissions, live summary, draft/publish distinction, and responsive navigation.
- Runs task monitor: search/status/agent/date filters; clear input, events, output, artifact, cost, and status-specific recovery presentation. It remains task-only until the proposed unified execution index is approved.
- Knowledge Hub: real drag/drop upload, processing visibility, workspace-scope explanation, retrieval testing, document inspection, extracted-text preview, and chunk preview via `GET /v1/knowledge/documents/:id`.
- Integrations: application-first Connected/App catalog/Custom API experience that summarizes real custom APIs and MCP applications; advanced MCP keeps tool discovery, OAuth, health, agent access, allowlists, and activity.
- Authentication, onboarding, dashboard, agents, queued tasks, and task output viewing.
- Markdown output viewing plus generated PDF, DOCX, PPTX, and XLSX artifacts.
- Knowledge upload, extraction, chunking, full-text search, and optional vector search.
- MCP Marketplace: Streamable HTTP connections, encrypted credentials, discovery, allowlists, permissions, health, logs, and agent assignment.
- Workflow execution: snapshots, branches, retries, bounded loops, approval, node traces, artifacts, and cost/usage limits.
- Workflow foundation: server-owned node registry and sanitized palette, workspace-scoped resource catalog, separate editor layout storage, modular Agent/API/MCP/Knowledge/Logic/File adapters, exact action-bound confirmations, and redacted tool-call audit data.
- Workflow editor: real React Flow canvas with drag/drop, typed handles, visible connections, pan/zoom/minimap/fullscreen, auto-layout, undo/redo, Simple/Advanced modes, schema-driven inspector, safe mapping insertion, permission review, active-path highlighting, and node-path testing.
- Workflow lifecycle: editable numbered drafts, full-draft tests, immutable published versions, pause/resume compatibility, and production runs pinned to a published version. Node-only tests deliberately cannot unlock publishing.
- Workspace PowerPoint themes: a safe `DESIGN.md` parser, default theme selection, and theme-aware PPTX rendering with title, card, and table layouts.

## Partial

- UX redesign: the shell, dashboard, Agent Builder, Runs task view, Knowledge Hub, Integrations entry experience, and workflow editor are substantially redesigned in source; unified Runs, Create consolidation, Settings/Analytics restructuring, and the final cross-device visual audit remain.
- Workflow editor: functional visual authoring and lifecycle are implemented in source, but the new migrations and database-backed workflow suite still require Docker verification, and the running page has not yet been visually inspected after rebuild.
- Knowledge retrieval: workspace-wide; agent runtime currently relies on full-text retrieval.
- MCP tools in workflows: exact discovered MCP actions assigned to active agents are available. Known app-logo rendering on canvas nodes remains incomplete.

## Missing

- Browser runtime and safe browser nodes.
- Full run replay from historical input; full-draft and node-path test input are implemented.
- Direct task/chat file attachments.
- Per-agent/per-collection knowledge permissions and citations.
- Unified task + workflow Runs index.

## Constraints

- Original `web/` app and port 3000 must remain intact.
- Stitch Edition is `web-stitch/` on port 3002.
- Never print `.env` values or secrets.
- `sources/` is read-only synced reference material.
