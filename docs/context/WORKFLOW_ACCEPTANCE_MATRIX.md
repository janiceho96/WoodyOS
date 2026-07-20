# Workflow Acceptance Matrix

Use this matrix to verify the production workflow objective. A checked box needs direct evidence: source inspection plus the relevant automated test and, for UI behavior, a running visual check.

## Foundation and safety

- [x] Server-side registry owns every supported node type, metadata, schema, ports, risk, and adapter selection.
- [ ] Graph-level validation rejects invalid topology, unsafe cycles, missing resources, and invalid data references.
- [x] Node-specific configuration and inspector fields come from the sanitized server registry; the client retains only immediate graph feedback.
- [x] Agent, API, MCP, Knowledge, Logic, and File adapters exist behind a common contract.
- [x] Browser is intentionally absent until an isolated policy-enforced runtime exists; there is no fake runnable browser node.
- [x] Workflows store resource references only; credentials and encrypted configuration remain backend-only.
- [x] Loops have hard iteration limits; model work honors workspace budget controls.
- [ ] External/destructive/unknown writes pass through one action gateway and require confirmation bound to the run, node, iteration, attempt, operation, argument hash, and expiry; they do not auto-retry.
- [x] A generic Approval node cannot authorize a changed or not-yet-resolved external action.
- [ ] Connected action calls create redacted audit evidence.
- [ ] Published versions are immutable and production runs snapshot the selected version.

## Editor

- [ ] Real drag-and-drop graph editor; not a static grid or dropdown-only edge editor.
- [ ] Typed connection handles and visible edges validate before save.
- [ ] Pan, zoom, minimap, full-screen, keyboard navigation, auto-layout, undo, and redo work.
- [ ] Simple mode guides normal creation; advanced mode exposes technical controls without hiding safety information.
- [ ] Palette is searchable and shows exact verified app/action names and logos where available.
- [ ] Inspector is generated from the server node schema rather than page-specific conditionals.
- [ ] Mapping picker inserts only safe references from compatible prior-node outputs.
- [ ] Inline validation explains the problem, affected node, and next action.
- [ ] Pre-publish review shows permissions, confirmation requirements, estimated usage/cost, agents, knowledge, and integrations.
- [ ] Node-level sample input/test is isolated from production publishing.

## Runs and recovery

- [ ] A run shows node input, output, errors, timing, retry state, approval state, and cost/usage where available.
- [ ] Active execution path is visible in the graph and trace.
- [ ] Approval decisions are tied to run, node, iteration, operation/arguments, and expiry.
- [ ] Artifact previews/downloads work for generated output types.
- [ ] Errors are human-readable and offer only supported recovery actions.
- [ ] Runs page can truthfully list/filter both agent tasks and workflow runs only after the unified execution index exists.

## Quality gate

- [x] Root TypeScript build passes.
- [x] Focused workflow unit tests pass.
- [ ] Database-backed workflow integration tests pass.
- [x] Stitch frontend build and lint pass (four pre-existing hook-dependency warnings remain outside the workflow implementation).
- [ ] Docker rebuild succeeds.
- [ ] Changed workflow UI has been visually checked at `http://localhost:3002` in desktop, tablet, mobile, light, and dark modes.
- [ ] Keyboard and screen-reader states are checked.
- [ ] `CURRENT_STATE.md` records verified completion and plain limitations.

## Current evidence snapshot — 2026-07-20

New source and local-test evidence: shared registry, sanitized node/resource catalogs, modular adapters, separate bounded layout schema, React Flow editor source, action-hash/redaction helpers, draft/test/publish routes, immutable production version selection, and node-path test stopping. Root build, 16 focused workflow/runtime tests, all 68 non-Docker tests, Stitch production build, and Stitch lint complete successfully.

Still unproven in this environment: migrations 019–022 against PostgreSQL, the expanded database integration suite, Docker rebuild, action-confirmation resume with Redis, artifact generation through the lifecycle, and the running canvas in desktop/mobile/light/dark states. Still absent: controlled Browser adapter, historical-run replay, exact known-app logos on canvas nodes, and the unified execution index.
