# Current task — artifacts and controlled workflow runtime

Status: implementation complete; Docker-backed operational verification remains.

## Delivered

- Additive migration 017 for artifact metadata, workflow snapshots/cursors,
  per-node attempt state, loop iteration keys and retry-safe task identities.
- Storage-adapter-based artifacts with Docker named-volume persistence,
  workspace-authenticated downloads, checksums and lifecycle/error states.
- Background PDF, DOCX, PPTX and XLSX generation from canonical agent/workflow
  Markdown through deterministic Python libraries. The model never supplies a
  trusted binary.
- Task format selection/inference, post-completion generation/retry, PDF preview,
  office-file downloads and artifact deletion in Execution Monitor.
- Persisted condition branches, bounded retries, explicit for-each/while loops,
  body/done/continue edges, approval-per-iteration and full trace visibility.
- Workflow Designer node inspector, connection editor, run input, approvals,
  attempts, loop iterations and workflow artifact downloads.
- Save-time and runtime protection for external/write-capable actions: direct
  human approval is mandatory and automatic retries are forbidden.
- Queue failure recovery prevents artifact or workflow jobs from silently
  remaining stuck in queued state.

## Verified on 2026-07-20

- `npm run build`: passed.
- `npm test -- --run`: 20 files passed, 1 database suite skipped; 60 tests
  passed and 9 database tests skipped.
- `cd web-stitch && npm run build`: passed.
- Python artifact tests: PDF/DOCX/PPTX/XLSX structural parsing passed, including
  PowerPoint table pagination without row loss.
- `docker compose config --quiet`: passed.

## Operational verification still required

The current Codex sandbox cannot access the user's Docker socket and ports
5432, 6380, 8000, 3001 and 3002 were closed during verification. After Docker
is started from the user's macOS session, run:

```sh
docker compose up --build -d
RUN_INTEGRATION=true DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus REDIS_URL=redis://localhost:6380 npm test -- tests/database.integration.test.ts
```

The integration suite uses `INTEGRATION_API_URL` (default
`http://localhost:3001`) for artifact downloads because the Docker API and
worker share the named artifact volume. Other route assertions run through the
in-process Fastify test app against the same Docker database and Redis.

Then create one task requesting all four formats and run the sample branch,
approval-loop and retry workflows from the Stitch UI. Do not claim this live
Docker verification passed until those commands are actually executed.

## Known boundaries

- Only PDF previews inline; DOCX, PPTX and XLSX download.
- Workflow graphs do not yet support sub-workflows, parallel joins or arbitrary
  cycles.
- Artifact local storage is durable in Docker but a production cloud deployment
  should add an object-storage adapter and retention policy.
