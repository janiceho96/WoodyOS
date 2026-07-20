# Woody Agent OS — compact Codex context

Last verified from source: 2026-07-20. This file records current architecture,
not the full project history. Inspect referenced code before changing behavior.

## Objective and non-negotiables

Woody is a local, workspace-scoped operating system for creating AI agents,
running auditable tasks and workflows, grounding them with knowledge, and
granting least-privilege API/MCP tools. Preserve the original app/port 3000.
The active Stitch Edition lives in `web-stitch/` and runs at
`http://localhost:3002`. Never expose secrets to the browser. External writes,
destructive operations, and unknown MCP actions require explicit confirmation.

Before a major architectural change, explain the better design and trade-offs
and wait for approval. Preserve unrelated user changes and working features.
Treat every file under `sources/` as read-only reference material.

## Runtime architecture

- Frontend: React 19, TypeScript, Vite, React Query and Framer Motion in
  `web-stitch/`. Nginx serves it and proxies `/v1`, `/health`, and `/docs`.
- API: Fastify in `src/server.ts`, normally port 3001. JWT authentication and
  business routes are workspace-scoped.
- Persistence: PostgreSQL 16 with pgvector. Use additive migrations in
  `src/db/migrations/`; never rewrite a migration that may have run.
- Jobs: Redis and BullMQ. `src/worker.ts` executes queued agent/workflow work and
  records events, usage, tool calls, approvals and output.
- Documents: Python service in `services/extractor/` handles supported uploads
  and deterministic PDF, DOCX, PPTX and XLSX generation. Generated binaries use
  a storage adapter; Docker mounts the durable `artifact_data` volume.
- AI: custom provider abstraction in `src/lib/ai-provider.ts`; Anthropic and
  OpenAI-compatible Chat Completions are supported. This is not LangChain or
  LangGraph.
- Deployment: `docker-compose.yml` runs api, worker, migrate, db, redis,
  extractor and web-stitch. `Woody.app`/`Install Woody.command` provide the
  macOS launcher, but an installed Dock copy may need reinstalling after changes.

## Implemented product areas

- Login/register, versioned onboarding, dashboard, agent CRUD/builder, queued
  tasks, execution events and Markdown/JSON output viewing.
- Workflow creation/execution with persisted definition snapshots, cursors and
  node-attempt traces. Supported nodes include agent, action, approval,
  condition, bounded for-each/while loop and output.
- Real output artifacts for tasks and workflow outputs: PDF, DOCX, PPTX and
  XLSX generation, authenticated downloads, checksums, status/error display,
  retries and PDF inline preview. Canonical Markdown/JSON remains preserved.
- Knowledge upload, extraction, chunking, full-text search and optional pgvector
  semantic search when an embedding endpoint is configured.
- REST tools plus an MCP Marketplace: Registry sync, custom Streamable HTTP
  endpoints, encrypted credentials, OAuth/bearer/custom-header auth, connection
  tests, discovery, health, logs, tool enablement, agent assignment, explicit
  allowlists and read/read-write access.
- Ten four-agent starter solutions and a prompt-to-agent/team proposal compiler.
- Real task analytics, local AI budgets/limits and provider rate-limit metadata
  when a compatible provider returns useful headers.
- Woody branding, an independently animated SVG mascot, and a movable advisory
  chatbot whose position is remembered.

## Known gaps and constraints

- Provider, base URL, model and API keys are process environment values.
  `GET /v1/runtime/config` returns safe provider/model metadata only; Settings
  cannot securely save or switch credentials yet.
- Office artifacts download to their native applications; only PDF has an
  inline browser preview. There is no in-browser DOCX/PPTX/XLSX renderer.
- Files cannot be attached directly to a task/chat. Knowledge access is
  workspace-wide rather than per-agent/per-collection. Agent retrieval in
  `src/lib/agent-runtime.ts` uses full-text search even when embeddings exist;
  citations, hybrid reranking, PPTX extraction and scanned-PDF OCR are missing.
- The workflow designer is a node/edge authoring surface but not free-positioned
  drag-and-drop. Sub-workflows and parallel joins are not implemented. Cycles
  remain forbidden except explicit bounded continue edges back to loop nodes.
- Woody chat is advisory and cannot mutate data, execute tools, create agents or
  run workflows. A future action system needs preview, policy checks,
  idempotency, approval and audit logging.
- MCP supports remote Streamable HTTP only. Stdio and other transports need new
  adapters. Third-party OAuth depends on correctly configured provider apps.
- Complete pixel-level comparison against every Stitch reference screen and
  final verification of the installed Dock launcher remain operational QA work.

## Important source locations

- API/routes: `src/server.ts`, `src/routes/`
- Worker/workflows: `src/worker.ts`, `src/routes/workflows.ts`,
  `src/workflows/definition.ts`, `src/workflows/runtime.ts`
- Artifacts: `src/artifacts/`, `src/routes/artifacts.ts`, migration 017,
  `services/extractor/main.py`
- Provider/runtime: `src/lib/ai-provider.ts`, `src/routes/runtime.ts`
- Knowledge: `src/routes/knowledge.ts`, `src/lib/agent-runtime.ts`,
  `services/extractor/`
- MCP: `src/mcp/`, `src/routes/mcp/`, migrations 010–013
- Solutions: `src/solutions/`, `src/routes/agent-solutions.ts`
- Usage: `src/lib/ai-usage.ts`, `src/routes/usage.ts`
- Woody chat: `src/routes/copilot.ts`,
  `web-stitch/src/features/copilot/WoodyChat.tsx`
- Frontend routes/API: `web-stitch/src/App.tsx`, `web-stitch/src/api.ts`

## Commands

```sh
npm run build
npm test
npm run db:migrate
cd web-stitch && npm run build
docker compose up --build
RUN_INTEGRATION=true npm test -- tests/database.integration.test.ts
```

Database integration requires reachable `DATABASE_URL` and `REDIS_URL` and a
migrated test database. Do not report Docker verification if the Docker socket
is unavailable. Never print `.env` contents or secret values in logs.

## Current development order

1. Secure provider configuration and switching.
2. Hybrid/per-agent RAG with citations.
3. Direct task/chat attachments (durable artifact output is implemented).
4. Confirmed Woody actions.
5. Sub-workflows and optional parallel workflow joins (branch/retry/controlled
   loops are implemented).
6. Additional MCP transports and final visual/deployment QA.

The active phase and acceptance criteria are in `docs/CURRENT_TASK.md`.
