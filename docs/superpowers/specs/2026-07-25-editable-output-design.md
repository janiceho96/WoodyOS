# Editable Output Design

Date: 2026-07-25  
Status: Approved for implementation

## Goal

Allow users to edit a completed task's output inside Woody while preserving the
agent's original response, maintaining a complete revision history, and
regenerating downloadable files from an explicitly selected saved revision.

## Approved Product Decisions

- Phase one supports completed task outputs only.
- `tasks.output` remains immutable run evidence.
- Markdown is the only canonical editable source.
- Every save creates an immutable numbered version.
- Reverting creates a new version copied from an older version.
- File regeneration is explicit, not automatic.
- PDF, DOCX, PPTX, XLSX, HTML, Markdown, TXT, CSV, and JSON remain derivatives.
- Direct native Office editing and direct HTML source editing are deferred.
- Change-summary fields are omitted from phase one.
- The maintained frontend remains port 3002.

## Architecture

### Output documents

Add an `output_documents` record for each editable task output. Creating a
document copies the current text from `tasks.output` into version 1 without
changing the task.

Each document has one current version number. `output_document_versions`
contains immutable Markdown content, a SHA-256 content hash, author identity,
and creation timestamp.

Saving uses optimistic concurrency:

1. The client sends `baseVersionNumber`.
2. The service locks the document row in a transaction.
3. If the stored current version differs, the save returns
   `OUTPUT_VERSION_CONFLICT`.
4. Otherwise, the service inserts the next numbered version and advances the
   document's current version.

### Revision-aware artifacts

Add `output_document_version_id` to `artifacts`.

Legacy artifacts with no version ID continue to use the original task or
workflow output. New files requested from the editor use the selected saved
version.

The existing unique constraint of one artifact per task and format is replaced
with:

- one legacy artifact per task/format when version ID is null;
- one artifact per task/format/version when version ID is present.

This allows a previous ready file to remain downloadable while a replacement
for a newer version is generating. The UI groups files by format and treats the
newest artifact for the current version as current; earlier files are
outdated.

### API

Register `outputDocumentRoutes` at `/v1/output-documents`.

Endpoints:

- `POST /v1/output-documents/tasks/:taskId`
  - Idempotently initializes a document from a completed task.
  - Returns the document, current version, and version list.
- `GET /v1/output-documents/tasks/:taskId`
  - Returns the existing document or `null`.
- `POST /v1/output-documents/:documentId/versions`
  - Body: `{ content, baseVersionNumber }`.
  - Saves a new version with conflict protection.
- `POST /v1/output-documents/:documentId/revert`
  - Body: `{ versionId, baseVersionNumber }`.
  - Copies an older version into a new current version.
- `POST /v1/output-documents/:documentId/artifacts`
  - Body: `{ versionId, formats }`.
  - Confirms the version belongs to the document and queues revision-aware
    artifacts.

All writes require owner, admin, or member role. All reads require an
authenticated user in the same workspace.

### Frontend

Add an `EditableOutput` feature with:

- rendered output view;
- **Edit output** action;
- Markdown source editor;
- live rendered preview;
- Save new version and Cancel;
- unsaved-change confirmation;
- version history;
- preview prior version;
- revert as new version;
- current/outdated artifact labels;
- explicit **Regenerate selected** control.

On desktop the editor uses a source/preview split view. On narrow screens it
uses Source and Preview tabs. Keyboard focus, labels, status announcements,
and confirmation dialogs follow the existing design system.

## Data Flow

### First edit

1. User opens a completed task and presses **Edit output**.
2. Frontend requests the task's output document.
3. If no document exists, frontend calls the idempotent initialize endpoint.
4. Version 1 is copied from the original task text.
5. The editor opens with version 1.

### Save

1. User edits Markdown and presses **Save new version**.
2. Frontend sends the content and loaded version number.
3. Backend validates length, task ownership, and version concurrency.
4. Backend inserts the next immutable version and updates the document.
5. UI returns to rendered mode and marks older generated files outdated.

### Regenerate

1. User selects formats.
2. Frontend sends the current version ID.
3. Backend creates version-scoped artifact rows and queues generation.
4. Artifact generation reads the version content, not `tasks.output`.
5. Previous ready downloads remain available until the new file is ready.

## Validation and Limits

- Content must contain between 1 and 100,000 Unicode characters.
- Document initialization requires a completed task with non-empty text.
- Artifact requests allow the existing supported format list and maximum of
  nine distinct formats.
- A version must belong to the requested document and workspace.
- A task may have only one output document.
- Version numbers are positive and sequential within a document.

## Security and Trust

- Original task output is never updated by editor routes.
- HTML remains generated and is previewed in the existing empty sandbox.
- No user-authored JavaScript executes.
- Storage keys and hashes needed only by the backend remain private.
- Every initialize, save, revert, and regeneration request writes an audit
  event without storing full output content in audit metadata.
- API responses contain content but never credentials, storage keys, or
  encrypted values.
- Workspace scoping is enforced in every query.

## Error Handling

- `OUTPUT_TASK_NOT_FOUND`: source task is absent or outside the workspace.
- `OUTPUT_TASK_NOT_COMPLETED`: task is not complete.
- `OUTPUT_SOURCE_EMPTY`: source has no editable text.
- `OUTPUT_DOCUMENT_NOT_FOUND`: document is absent or outside the workspace.
- `OUTPUT_VERSION_NOT_FOUND`: requested version is absent or mismatched.
- `OUTPUT_VERSION_CONFLICT`: another editor saved first.
- `OUTPUT_CONTENT_INVALID`: content is empty or exceeds the limit.
- `OUTPUT_ARTIFACT_QUEUE_UNAVAILABLE`: version is saved, but file generation
  could not be queued.

On a conflict, the frontend preserves the local draft and offers:

- Reload latest;
- Copy my draft to clipboard;
- Cancel and keep editing.

## Testing

### Unit tests

- Output text normalization and content hashing.
- Version request validation.
- Current/outdated artifact grouping.

### Database-backed integration tests

- Initialize from completed task.
- Preserve `tasks.output`.
- Sequential saves and author metadata.
- Reject stale base versions.
- Revert as a new version.
- Deny cross-workspace access.
- Generate a version-scoped artifact.
- Keep the older ready artifact while a newer one is queued.

### Frontend validation

- Build and lint.
- Editor source/preview behavior.
- Unsaved-change confirmation.
- Conflict recovery.
- Version history and revert.
- Current/outdated artifact state.
- Responsive desktop and mobile layouts.

### End-to-end verification

- Build and start API and `web-stitch`.
- Open a completed task on port 3002.
- Initialize, edit, save, preview history, revert, and regenerate at least
  Markdown and HTML.
- Confirm the original task result remains unchanged.
- Confirm HTML preview remains sandboxed.

## Deferred Scope

- Workflow-run output editing.
- Native Word, PowerPoint, or Excel editing.
- Direct HTML source editing.
- Collaborative cursors and real-time merging.
- Paragraph comments and review approvals.
- AI rewrite commands inside the editor.
- Durable offline drafts.
- Editing running, failed, or cancelled task outputs.
