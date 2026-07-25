# Editable Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe, versioned Markdown editor for completed task outputs and regenerate downloadable files from a selected saved revision.

**Architecture:** Preserve `tasks.output` as immutable run evidence. Store editable content in one output document with immutable numbered versions, use optimistic concurrency for saves, and attach regenerated artifacts to the exact version that produced them.

**Tech Stack:** TypeScript, Fastify, PostgreSQL 16, React 19, TanStack Query, React Markdown, Vitest, Docker Compose.

## Global Constraints

- Phase one supports completed task outputs only.
- Every save creates a new immutable version.
- `tasks.output` must never be updated by editor code.
- Markdown is the single canonical editable source.
- File regeneration is explicit.
- Existing HTML sandbox restrictions remain unchanged.
- The maintained frontend is `web-stitch` on port 3002.
- Preserve unrelated changes in the existing dirty worktree.
- Do not stage or commit implementation files containing unrelated user changes.

---

### Task 1: Output-document schema and pure contracts

**Files:**
- Create: `src/db/migrations/028_editable_outputs.sql`
- Create: `src/outputs/types.ts`
- Test: `tests/editable-output.test.ts`

**Interfaces:**
- Produces: `outputContentSchema`, `createOutputContentHash(content)`,
  `OutputDocumentRecord`, `OutputVersionRecord`, and
  `classifyArtifactRevision(artifactVersionId, currentVersionId)`.
- Consumes: existing UUID users, workspaces, tasks, and artifacts tables.

- [ ] **Step 1: Write the failing contract tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  classifyArtifactRevision,
  createOutputContentHash,
  outputContentSchema,
} from '../src/outputs/types.js';

describe('editable output contracts', () => {
  it('validates bounded non-empty Markdown', () => {
    expect(outputContentSchema.parse('# Revised result')).toBe('# Revised result');
    expect(outputContentSchema.safeParse('   ').success).toBe(false);
    expect(outputContentSchema.safeParse('x'.repeat(100_001)).success).toBe(false);
  });

  it('creates stable content hashes', () => {
    expect(createOutputContentHash('# Result')).toMatch(/^[a-f0-9]{64}$/);
    expect(createOutputContentHash('# Result')).toBe(createOutputContentHash('# Result'));
  });

  it('classifies current, outdated and original artifacts', () => {
    expect(classifyArtifactRevision('v2', 'v2')).toBe('current');
    expect(classifyArtifactRevision('v1', 'v2')).toBe('outdated');
    expect(classifyArtifactRevision(null, 'v2')).toBe('original');
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- tests/editable-output.test.ts
```

Expected: FAIL because `src/outputs/types.ts` does not exist.

- [ ] **Step 3: Implement the pure contracts**

```ts
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const outputContentSchema = z.string().trim().min(1).max(100_000);

export function createOutputContentHash(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

export function classifyArtifactRevision(
  artifactVersionId: string | null | undefined,
  currentVersionId: string,
) {
  if (!artifactVersionId) return 'original' as const;
  return artifactVersionId === currentVersionId ? 'current' as const : 'outdated' as const;
}
```

Define database record types in the same file:

```ts
export type OutputDocumentRecord = {
  id: string;
  workspace_id: string;
  task_id: string;
  current_version_number: number;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type OutputVersionRecord = {
  id: string;
  workspace_id: string;
  document_id: string;
  version_number: number;
  content: string;
  content_hash: string;
  created_by: string | null;
  created_by_name?: string | null;
  created_at: Date | string;
};

export type OutputDocumentDetail = OutputDocumentRecord & {
  currentVersion: OutputVersionRecord;
  versions: OutputVersionRecord[];
};
```

- [ ] **Step 4: Add migration 028**

Create:

```sql
CREATE TABLE output_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  current_version_number INTEGER NOT NULL DEFAULT 1 CHECK(current_version_number >= 1),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(task_id)
);

CREATE TABLE output_document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES output_documents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK(version_number >= 1),
  content TEXT NOT NULL CHECK(length(btrim(content)) BETWEEN 1 AND 100000),
  content_hash TEXT NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(document_id,version_number)
);

ALTER TABLE artifacts
  ADD COLUMN output_document_version_id UUID
  REFERENCES output_document_versions(id) ON DELETE RESTRICT;

DROP INDEX IF EXISTS artifacts_task_format_unique;
CREATE UNIQUE INDEX artifacts_task_format_legacy_unique
  ON artifacts(task_id,format)
  WHERE task_id IS NOT NULL AND output_document_version_id IS NULL;
CREATE UNIQUE INDEX artifacts_task_format_version_unique
  ON artifacts(task_id,format,output_document_version_id)
  WHERE task_id IS NOT NULL AND output_document_version_id IS NOT NULL;

CREATE INDEX output_documents_workspace_updated_idx
  ON output_documents(workspace_id,updated_at DESC);
CREATE INDEX output_versions_document_created_idx
  ON output_document_versions(document_id,version_number DESC);
CREATE INDEX artifacts_output_version_idx
  ON artifacts(output_document_version_id)
  WHERE output_document_version_id IS NOT NULL;
```

- [ ] **Step 5: Run the focused test and backend build**

```bash
npm test -- tests/editable-output.test.ts
npm run build
```

Expected: PASS and successful TypeScript build.

---

### Task 2: Transactional output-document service

**Files:**
- Create: `src/outputs/service.ts`
- Modify: `tests/editable-output.test.ts`

**Interfaces:**
- Consumes: `db` from `src/db/client.ts`, `outputText` from
  `src/artifacts/types.ts`, and contracts from `src/outputs/types.ts`.
- Produces:

```ts
initializeTaskOutputDocument(input: {
  workspaceId: string;
  taskId: string;
  actorId: string;
}): Promise<OutputDocumentDetail>

getTaskOutputDocument(workspaceId: string, taskId: string):
  Promise<OutputDocumentDetail | null>

saveOutputVersion(input: {
  workspaceId: string;
  documentId: string;
  actorId: string;
  content: string;
  baseVersionNumber: number;
}): Promise<OutputDocumentDetail>

revertOutputVersion(input: {
  workspaceId: string;
  documentId: string;
  actorId: string;
  versionId: string;
  baseVersionNumber: number;
}): Promise<OutputDocumentDetail>
```

- [ ] **Step 1: Add failing database integration cases**

Add one integration test that registers a user, creates and completes a task,
then asserts:

```ts
const original = await query('SELECT output FROM tasks WHERE id=$1', [taskId]);
const initialized = await initializeTaskOutputDocument({ workspaceId, taskId, actorId });
expect(initialized.currentVersion.version_number).toBe(1);

const saved = await saveOutputVersion({
  workspaceId,
  documentId: initialized.id,
  actorId,
  content: '# Human revision',
  baseVersionNumber: 1,
});
expect(saved.currentVersion.version_number).toBe(2);

await expect(saveOutputVersion({
  workspaceId,
  documentId: initialized.id,
  actorId,
  content: '# Stale edit',
  baseVersionNumber: 1,
})).rejects.toThrow('OUTPUT_VERSION_CONFLICT');

expect((await query('SELECT output FROM tasks WHERE id=$1', [taskId])).rows[0].output)
  .toEqual(original.rows[0].output);
```

- [ ] **Step 2: Run the integration case and verify RED**

```bash
RUN_INTEGRATION=true \
DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus \
REDIS_URL=redis://localhost:6380 \
npm test -- tests/database.integration.test.ts
```

Expected: FAIL because the service functions do not exist.

- [ ] **Step 3: Implement transactional initialize and save**

Use `const client = await db.connect()`, `BEGIN`, and
`SELECT ... FOR UPDATE`. Throw errors with explicit status codes:

```ts
throw Object.assign(new Error('OUTPUT_VERSION_CONFLICT'), { statusCode: 409 });
```

Initialization must be idempotent:

1. lock or insert the document;
2. copy `outputText(task.output)` only when creating version 1;
3. return the existing document if another request initialized it first.

- [ ] **Step 4: Implement revert as a new version**

Load the requested historical content inside the same locked transaction, then
call the same internal insert logic as a normal save. Never update an existing
version row.

- [ ] **Step 5: Run focused unit, integration, and build checks**

```bash
npm test -- tests/editable-output.test.ts
RUN_INTEGRATION=true \
DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus \
REDIS_URL=redis://localhost:6380 \
npm test -- tests/database.integration.test.ts
npm run build
```

Expected: all pass.

---

### Task 3: Output-document API and authorization

**Files:**
- Create: `src/routes/output-documents.ts`
- Modify: `src/server.ts`
- Modify: `tests/api-validation.test.ts`
- Modify: `tests/database.integration.test.ts`

**Interfaces:**
- Consumes: service functions from Task 2 and `audit`.
- Produces the initialize, read, save, and revert endpoints. Task 4 adds the
  revision-aware artifact endpoint after its service exists.

- [ ] **Step 1: Add failing validation tests**

Add API cases asserting:

```ts
expect((await app.inject({
  method: 'POST',
  url: `/v1/output-documents/${documentId}/versions`,
  headers,
  payload: { content: '', baseVersionNumber: 1 },
})).statusCode).toBe(400);

expect((await app.inject({
  method: 'POST',
  url: `/v1/output-documents/${documentId}/versions`,
  headers,
  payload: { content: '# Revision', baseVersionNumber: 0 },
})).statusCode).toBe(400);
```

Also verify a second workspace receives 404 for the first workspace's
document.

- [ ] **Step 2: Run validation tests and verify RED**

```bash
npm test -- tests/api-validation.test.ts
```

Expected: FAIL with missing route or unexpected 404.

- [ ] **Step 3: Implement and register routes**

Use these Zod schemas:

```ts
const versionInput = z.object({
  content: outputContentSchema,
  baseVersionNumber: z.number().int().min(1),
});
const revertInput = z.object({
  versionId: z.string().uuid(),
  baseVersionNumber: z.number().int().min(1),
});
```

Register:

```ts
await app.register(outputDocumentRoutes, { prefix: '/v1/output-documents' });
```

Audit actions:

- `output_document.initialized`
- `output_document.version_created`
- `output_document.reverted`
- `output_document.artifacts_requested`

Metadata may contain IDs, version numbers, and formats, never document content.

- [ ] **Step 4: Run API and integration tests**

```bash
npm test -- tests/api-validation.test.ts tests/editable-output.test.ts
RUN_INTEGRATION=true \
DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus \
REDIS_URL=redis://localhost:6380 \
npm test -- tests/database.integration.test.ts
```

Expected: all pass.

---

### Task 4: Revision-aware artifact generation

**Files:**
- Modify: `src/artifacts/types.ts`
- Modify: `src/artifacts/service.ts`
- Modify: `src/routes/artifacts.ts`
- Modify: `tests/artifacts.test.ts`
- Modify: `tests/database.integration.test.ts`

**Interfaces:**
- Extends `ArtifactRecord` with
  `output_document_version_id: string | null`.
- Produces:

```ts
requestTaskVersionArtifacts(input: {
  workspaceId: string;
  createdBy: string | null;
  taskId: string;
  versionId: string;
  title: string;
  formats: ArtifactFormat[];
}): Promise<ArtifactRecord[]>
```

- Adds `POST /v1/output-documents/:documentId/artifacts` after implementing
  `requestTaskVersionArtifacts`.

- [ ] **Step 1: Write failing artifact tests**

Assert that a version-scoped source returns its saved Markdown and that two
versions may each have one PDF artifact without deleting the older row.

- [ ] **Step 2: Run focused artifact tests and verify RED**

```bash
npm test -- tests/artifacts.test.ts
```

Expected: FAIL because version-scoped artifact fields and request function are
missing.

- [ ] **Step 3: Extend artifact source resolution**

In `sourceFor`, check `artifact.output_document_version_id` first:

```sql
SELECT t.title,v.content output,t.requested_by created_by,t.status
FROM output_document_versions v
JOIN output_documents d ON d.id=v.document_id
JOIN tasks t ON t.id=d.task_id
WHERE v.id=$1 AND v.workspace_id=$2 AND t.id=$3
```

Legacy artifacts continue through the existing task/workflow branches.

- [ ] **Step 4: Add version-scoped request behavior**

Insert artifact rows with `output_document_version_id`. Never reset or delete
an artifact for another version.

If queueing fails, mark only the newly requested version rows failed and throw
`OUTPUT_ARTIFACT_QUEUE_UNAVAILABLE`.

- [ ] **Step 5: Run artifact, integration, and build checks**

```bash
npm test -- tests/artifacts.test.ts tests/editable-output.test.ts
RUN_INTEGRATION=true \
DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus \
REDIS_URL=redis://localhost:6380 \
npm test -- tests/database.integration.test.ts
npm run build
```

Expected: all pass.

---

### Task 5: Frontend API and editor component

**Files:**
- Modify: `web-stitch/src/api.ts`
- Create: `web-stitch/src/components/outputs/EditableOutput.tsx`
- Create: `web-stitch/src/components/outputs/editable-output.css`
- Modify: `web-stitch/src/main.tsx`
- Test: `tests/frontend-file-security.test.ts`

**Interfaces:**
- Produces frontend types:

```ts
type OutputVersion = {
  id: string;
  version_number: number;
  content: string;
  content_hash: string;
  created_by_name?: string | null;
  created_at: string;
};

type OutputDocumentDetail = {
  id: string;
  task_id: string;
  current_version_number: number;
  currentVersion: OutputVersion;
  versions: OutputVersion[];
};
```

- Produces API methods:

```ts
outputDocumentForTask(taskId: string)
initializeOutputDocument(taskId: string)
saveOutputVersion(documentId: string, body)
revertOutputVersion(documentId: string, body)
requestOutputArtifacts(documentId: string, body)
```

- [ ] **Step 1: Add failing frontend security/source tests**

Assert the new editor:

- renders Markdown with `ReactMarkdown`;
- does not use `dangerouslySetInnerHTML`;
- does not add iframe permissions;
- includes conflict handling and unsaved-change confirmation.

- [ ] **Step 2: Run the test and verify RED**

```bash
npm test -- tests/frontend-file-security.test.ts
```

Expected: FAIL because `EditableOutput.tsx` does not exist.

- [ ] **Step 3: Add API types, methods, and error messages**

Map:

- `OUTPUT_VERSION_CONFLICT`
- `OUTPUT_TASK_NOT_COMPLETED`
- `OUTPUT_SOURCE_EMPTY`
- `OUTPUT_CONTENT_INVALID`
- `OUTPUT_ARTIFACT_QUEUE_UNAVAILABLE`

Use the existing authenticated `request<T>()` helper.

- [ ] **Step 4: Implement the editor**

Component props:

```ts
type EditableOutputProps = {
  task: TaskDetail;
  refreshTask: () => void;
};
```

Required states:

- view;
- initializing;
- editing source;
- preview;
- saving;
- history;
- conflict;
- error.

Use a textarea for Markdown source and `ReactMarkdown` with `remarkGfm` for the
preview. Preserve local draft content on every API error.

- [ ] **Step 5: Implement accessible responsive styling**

Desktop: two-column source/preview.  
Mobile: Source and Preview tabs.  
Use existing typography tokens and button classes.  
Do not introduce a new font family.

- [ ] **Step 6: Run frontend checks**

```bash
cd web-stitch
npm run build
npm run lint
cd ..
npm test -- tests/frontend-file-security.test.ts
```

Expected: build, lint, and tests pass without warnings.

---

### Task 6: Agent workspace integration and artifact states

**Files:**
- Modify: `web-stitch/src/features/execution/ExecutionPage.tsx`
- Modify: `web-stitch/src/api.ts`
- Modify: `web-stitch/src/index.css` only if shared state styles are required
- Modify: `tests/frontend-file-security.test.ts`

**Interfaces:**
- Consumes `EditableOutput`.
- Extends `Artifact` with `output_document_version_id`.
- Produces current, outdated, original, generating, and failed labels.

- [ ] **Step 1: Add failing source-level integration assertions**

Assert `ExecutionDetail` renders `EditableOutput` for completed tasks and that
artifact state derives from the document's current version ID.

- [ ] **Step 2: Run the frontend test and verify RED**

```bash
npm test -- tests/frontend-file-security.test.ts
```

Expected: FAIL because execution detail still renders only `OutputViewer`.

- [ ] **Step 3: Integrate the editor**

Replace the completed task's read-only output section with:

```tsx
<EditableOutput task={task} refreshTask={refresh}/>
```

Keep `OutputViewer` for inputs, errors, running tasks, and non-editable output
states.

- [ ] **Step 4: Group revision-aware artifacts**

Show the newest artifact for each format in the primary list. Older artifacts
remain available inside an expandable history section. Labels must be:

- Current revision
- Older revision
- Original agent output
- Generating
- Failed

- [ ] **Step 5: Run frontend and focused backend checks**

```bash
cd web-stitch
npm run build
npm run lint
cd ..
npm test -- tests/frontend-file-security.test.ts tests/artifacts.test.ts tests/editable-output.test.ts
```

Expected: all pass.

---

### Task 7: Database migration, end-to-end verification, and port 3002 deployment

**Files:**
- Modify only if verification reveals a tested defect in files from Tasks 1–6.

**Interfaces:**
- Consumes the completed backend, frontend, migration, and Docker services.
- Produces a verified deployment on port 3002.

- [ ] **Step 1: Run migration and database-backed tests**

```bash
docker compose up -d db redis extractor
DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus npm run db:migrate
RUN_INTEGRATION=true \
DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus \
REDIS_URL=redis://localhost:6380 \
npm test -- tests/database.integration.test.ts
```

Expected: migration completes and all integration tests pass.

- [ ] **Step 2: Run complete build and test gates**

```bash
npm test
npm run build
cd web-stitch
npm run build
npm run lint
cd ..
```

Expected: all commands pass.

- [ ] **Step 3: Rebuild the maintained services**

```bash
docker compose up -d --build api worker web-stitch
docker compose ps api worker web-stitch
curl --fail http://localhost:3001/health
curl --fail -I http://localhost:3002/
```

Expected: API, worker, and `web-stitch` are running; health and frontend return
success.

- [ ] **Step 4: Verify the browser flow**

On `http://localhost:3002`:

1. Open a completed task.
2. Press **Edit output**.
3. Confirm version 1 matches the original output.
4. Edit Markdown and save version 2.
5. Confirm the rendered result updates.
6. Open history and preview version 1.
7. Revert version 1 and confirm version 3 is created.
8. Regenerate Markdown and HTML.
9. Confirm old downloads remain available and are labeled outdated.
10. Confirm HTML opens only in the static sandbox.
11. Confirm a page refresh preserves the selected current version.

- [ ] **Step 5: Inspect security and runtime logs**

```bash
docker compose logs --tail=200 api worker |
  rg 'OUTPUT_|error|statusCode\":5' || true
git diff --check
git status --short
```

Expected: no unexpected server errors, no whitespace errors, and only
intentional working-tree changes.
