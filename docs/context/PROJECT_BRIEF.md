# Woody Project Brief

## Product

Woody is a workspace-scoped AI Agent Operating System for building, supervising, and running safe AI agent workflows.

## Users

- Solo professionals
- Small teams
- AI automation builders

## Product principles

1. Simple before powerful.
2. Real backend-connected functionality; no pretend actions.
3. Human approval for consequential external or destructive actions.
4. Exact app identities and operations, not vague “tools”.
5. Visible costs, permissions, status, and errors.
6. Draft before production publishing.
7. Preserve working features during upgrades.

## Technical foundation

- React/Vite frontend in `web-stitch/` on port 3002.
- Fastify API, PostgreSQL, Redis/BullMQ, Docker.
- MCP and API tools; secrets remain server-side.

## Never do

- Expose credentials or secrets to the browser.
- Silently perform external writes.
- Break existing workflows during architecture upgrades.
- Claim a feature is working without proportionate verification.
