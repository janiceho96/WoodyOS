# Workflow Foundation Design

Status: approved and implemented in source on 2026-07-20. Local builds and unit tests pass; database migrations, Docker-backed integration tests, and live visual verification remain pending.

## Why this change is needed

The current workflow runtime is safe and functional, but workflow node types are declared in a fixed Zod enum and executed in one `if`/`else` chain. Adding MCP actions, API actions, Knowledge retrieval, Browser work, typed handles, or canvas validation directly to that shape would duplicate rules and make safety checks easy to miss.

The recommended design keeps the current graph format and runtime behavior, but gives each node a reusable server-side contract.

## Target boundary

```text
Workflow definition (nodes + edges, no credentials)
                 │
                 ▼
Server node registry ── validates config, ports, risk, retry and permissions
                 │
                 ▼
Adapter executor ── agent / custom API / MCP / knowledge / logic / file
                 │
                 ▼
Policy checks ── access, confirmation, budget, idempotency, audit
                 │
                 ▼
Persisted run state, events, node state, artifacts
```

The React canvas consumes a **sanitized palette** from the registry. It never receives credentials, encrypted configuration, internal execution code, or unapproved tool access.

## Canonical node categories

| Category | Initial node types | Adapter | Notes |
| --- | --- | --- |
| Control | Trigger, condition, loop, approval | `logic` | Preserve existing deterministic control behavior and hard loop limits. |
| AI work | Agent | `agent` | Reuse the existing queued agent-task runtime. |
| Connected actions | Custom API action, MCP tool action | `api`, `mcp` | Resource IDs only; resolve enabled workspace resources at save/run time. A direct MCP node must name the agent whose allowlist and permission level authorize it. |
| Context | Knowledge search | `knowledge` | Reuse existing retrieval service; no raw document credentials. |
| Output | Return/output, file artifact | `file` | Reuse artifact renderer and existing output formats. |
| Browser | None initially | `browser` later | Do not expose a runnable browser node until a server-side, policy-enforced browser runtime exists. The palette may describe it as unavailable, not actionable. |

## Exact implementation units

### Backend shared contracts

- Add `src/workflows/registry.ts`.
  - Defines public metadata: type, category, title, description, icon key, input/output ports, config schema summary, risk, retry policy, and availability.
  - Defines internal metadata: full Zod config validator and adapter key.
  - Starts with the existing seven types so existing workflows remain valid, then adds canonical `api_action`, `mcp_action`, and `knowledge_search` types through explicit compatibility parsing rather than silently changing saved definitions.
- Add `src/workflows/adapters/types.ts`.
  - Defines one execution context and normalized execution result.
- Add adapters under `src/workflows/adapters/`.
  - `logic.ts`, `agent.ts`, `api.ts`, `mcp.ts`, `knowledge.ts`, `file.ts`.
  - Migrate legacy node behavior incrementally; no runtime rewrite in one commit.
- Add `src/policy/action-gateway.ts`.
  - Receives the resolved operation, risk, target, redacted arguments, argument hash, idempotency key, actor/resource access, and run/node/iteration identity.
  - Returns `allowed`, `awaiting_confirmation`, or `denied` before any external action executes.
  - A normal Approval node remains useful as a business gate, but it cannot replace action-bound confirmation unless it approved the exact resolved operation and argument hash.
- Update `src/workflows/definition.ts`.
  - Keep `nodes` and `edges` canonical.
  - Delegate node-specific validation to the registry while retaining global graph validation, safe reference parsing, loop limits, and retry limits.
- Update `src/workflows/runtime.ts`.
  - Dispatch a validated node to its adapter.
  - Retain durable cursor/state/event lifecycle in the runtime orchestrator.

### Backend routes and resource resolution

- Add `src/routes/workflow-nodes.ts` and register it in `src/server.ts`.
  - `GET /v1/workflow-nodes`: authenticated, sanitized static node palette and availability only.
  - Does not return credentials, endpoint headers, encrypted tool configuration, or unrestricted remote schemas.
- Add `src/routes/workflow-resources.ts` and register it in `src/server.ts`.
  - `GET /v1/workflow-resources`: workspace-scoped agents, API tools, MCP tools, Knowledge scope, display metadata, and permission/risk summaries for reusable resource pickers.
  - Remote MCP schemas and descriptions are size-bounded and treated as untrusted display data.
- Extend `src/routes/workflows.ts`.
  - Validate resource IDs and required approval edges through registry metadata.
  - Resolve API and MCP tools server-side with workspace scoping, enabled/healthy checks, selected-agent access checks, and least-privilege permissions.
- Reuse `src/mcp/runtime.ts` for MCP invocation so existing tool-call logs, redaction, and permission checks remain authoritative.
- Extend `src/routes/mcp/tool-calls.ts` and the MCP checkpoint flow for direct workflow MCP nodes.
  - Existing confirmation resumption assumes every MCP call belongs to an agent task. Direct workflow calls need to resume `workflow_runs` instead of requiring a task ID.
  - Approval remains tied to the selected agent, workflow run, node, loop iteration, attempt, tool, argument hash, and expiry.
- Add a unified workflow action-decision route in `src/routes/workflow-actions.ts`.
  - `POST /v1/workflow-actions/:id/decision` resolves a pending action-bound confirmation and resumes the correct workflow run.
  - The route never accepts replacement arguments; changed arguments create a new hash and require a new confirmation.

### Database migration

Add forward-only migrations with one responsibility each:

`src/db/migrations/019_workflow_editor_layouts.sql`:

- `workflow_editor_layouts`
  - workspace ID, workflow ID, editor schema version, positions JSONB, viewport JSONB, updated timestamps.
  - Unique per workflow/editor schema version.
  - Stores **only presentation state**, never executable configuration or credentials.
- Do **not** add an MCP credential or API secret column to workflows.

`src/db/migrations/020_workflow_action_authorizations.sql`:

- Add `workflow_action_authorizations` with workspace, workflow run, node, iteration, attempt, adapter, resource/operation identity, risk, redacted argument summary, argument hash, idempotency key, status, expiry, and resolver fields.
- Enforce one active authorization per exact action attempt and preserve resolved decisions for audit.
- Store no credentials and no unredacted secret-bearing arguments.

`src/db/migrations/021_workflow_mcp_runtime.sql`:

- Add workflow node/iteration/attempt identity to MCP tool-call records so a resumed node can find the exact approved call.
- Keep `agent_id` as the permission subject for a direct MCP node; allow `task_id` to remain null when `workflow_run_id` is present.
- Add database checks ensuring a call belongs to a task, workflow run, or both.
- Link the MCP tool-call record to its workflow action authorization so policy and transport audit remain traceable without duplicating secrets.

`src/db/migrations/022_workflow_versions.sql` (lifecycle phase):

- Store immutable published definition snapshots separately from the editable draft.
- Record the published version used by each production run.
- Do not silently mutate an already published version.

### Layout API

- `GET /v1/workflows/:id/layout`
- `PUT /v1/workflows/:id/layout`

Both are workspace-scoped. The API accepts only bounded node positions and viewport values; it cannot mutate workflow execution configuration.

### Frontend follow-up

- Add registry types and calls in `web-stitch/src/api.ts`.
- Keep `WorkflowsPage.tsx` working while a canvas component is introduced separately.
- Add a reusable resource picker that shows exact connected application/action names only when server data verifies them.
- Introduce React Flow only as an editor/view layer after this API exists. The saved Woody definition remains independent of React Flow.

## Safety rules enforced by the registry

- Canonical risk values are `read`, `write`, `external_write`, `destructive`, and `unknown`; the UI labels `write` as “reversible write”.
- `write`, `destructive`, `external_write`, or `unknown` requires action-bound confirmation for the exact resolved operation and argument hash and cannot automatically retry.
- Every external call atomically claims its exact authorization before transport execution. A crash with an uncertain outcome halts instead of repeating a potentially non-idempotent write; encrypted recovery output is never returned by catalog or run-detail APIs.
- A generic Approval node is a business-process gate; by itself it is not authorization for a later external write whose final arguments were not part of that approval.
- A direct MCP action requires an enabled, healthy connection, enabled discovered tool, selected agent, that agent’s connection/tool allowlist, and read/write permission where applicable.
- API action requires an enabled workspace tool and safe endpoint checks already enforced by the API tool runtime.
- Browser remains unavailable until there is a controlled server-side browser service.
- Only safe `{{ path }}` references are resolved; no JavaScript, shell, or arbitrary expressions.
- Runs use immutable definition snapshots. Published versions are a later lifecycle feature, not silently simulated now.
- The shared action gateway records the decision and redacted argument hash for all external actions. MCP also retains its transport-level tool-call record. The current generic API tool runtime does not provide this audit boundary by itself, so new workflow API actions must pass through the gateway.

## Trade-offs

| Option | Benefit | Cost / risk |
| --- | --- | --- |
| Add types directly to current enum and runtime switch | Fastest short-term UI change | Repeats validation and permission logic; canvas and backend drift; high regression risk. |
| Registry + adapters first (recommended) | One safety contract for runtime and canvas; incremental; supports new integrations | Adds several small modules and a catalog endpoint before visual polish. |
| Build React Flow first | Immediate visual improvement | Produces a prettier editor that cannot truthfully expose typed MCP/API/browser capabilities. |

## Delivery sequence

1. Registry wrapping existing nodes plus safe public catalog endpoint and regression tests.
2. Layout storage/API, without changing executable workflow JSON.
3. Shared action gateway plus API/MCP/Knowledge adapters and direct workflow confirmation resumption, with permission tests; Browser explicitly unavailable.
4. React Flow canvas: drag/connect, typed handles, pan/zoom/minimap/fullscreen, undo/redo, auto-layout, simple/advanced mode.
5. Draft/publish versions, test/replay input, mapping picker, cost/permission preview, execution path highlighting.

## Approval requested

Approve this foundation before runtime/database changes. It preserves the current workflow engine while creating the needed safe boundary for the real visual editor and exact integration actions.
