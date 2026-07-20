# Current State

Last verified: 2026-07-20.

## Working

- Phase 1 UX foundation: grouped seven-item navigation, goal-first dashboard, contextual Templates/MCP entry points, Runs terminology, live-work indicator, and direct dashboard-to-Prompt-to-Agent handoff.
- Guided Agent Builder: five-step Purpose, Instructions, Resources, Model, and Review flow with progressive model controls, explicit least-access permissions, live summary, draft/publish distinction, and responsive navigation.
- Authentication, onboarding, dashboard, agents, queued tasks, and task output viewing.
- Markdown output viewing plus generated PDF, DOCX, PPTX, and XLSX artifacts.
- Knowledge upload, extraction, chunking, full-text search, and optional vector search.
- MCP Marketplace: Streamable HTTP connections, encrypted credentials, discovery, allowlists, permissions, health, logs, and agent assignment.
- Workflow execution: snapshots, branches, retries, bounded loops, approval, node traces, artifacts, and cost/usage limits.
- Workspace PowerPoint themes: a safe `DESIGN.md` parser, default theme selection, and theme-aware PPTX rendering with title, card, and table layouts.

## Partial

- UX redesign: the shell, dashboard, and Agent Builder are complete in source; workflow canvas, Knowledge assignment, integration details, and human-readable recovery flows remain later phases.
- Workflow editor: functional node/edge authoring and inspector, but not a free-positioned drag-and-drop canvas.
- Knowledge retrieval: workspace-wide; agent runtime currently relies on full-text retrieval.
- MCP tools in workflows: MCP runtime is robust, but the workflow editor does not yet expose exact discovered app/tool nodes.

## Missing

- Node registry and unified workflow action adapters.
- React Flow canvas, typed drag connections, full-screen editor, undo/redo, and data picker.
- Browser runtime and safe browser nodes.
- Draft/publish workflow versions and replay/test-data mode.
- Direct task/chat file attachments.
- Per-agent/per-collection knowledge permissions and citations.

## Constraints

- Original `web/` app and port 3000 must remain intact.
- Stitch Edition is `web-stitch/` on port 3002.
- Never print `.env` values or secrets.
- `sources/` is read-only synced reference material.
