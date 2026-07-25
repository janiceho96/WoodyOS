# Woody Editable Output Context

Updated: 2026-07-25  
Status: Planning context only — implementation is not approved or started.

## Objective

Let a user revise an agent's completed result inside Woody, preview the revised
content, and regenerate downloadable files from the approved revision.

The user selected this direction:

> Edit the master Markdown/HTML content inside Woody, then regenerate PDF,
> Word, PowerPoint, Excel, and other derivatives from it.

This feature must not turn Woody into separate native Word, PowerPoint, and
Excel editors.

## Product Outcome

A completed run should have an understandable output lifecycle:

1. The agent produces the original result.
2. Woody preserves that original result as run evidence.
3. The user opens an editable working copy.
4. The user revises and previews the content.
5. Saving creates a traceable revision.
6. Exported files are generated from the selected saved revision.
7. Woody clearly shows whether each downloadable file is current or outdated.

## Current System

### Source output

- Agent tasks persist their result in `tasks.output`.
- The worker currently writes a JSON object shaped like
  `{ "text": "...", "toolCallCount": number }`.
- Workflow runs persist their final result separately in
  `workflow_runs.output`.
- `web-stitch/src/components/OutputViewer.tsx` renders text through
  `react-markdown` and falls back to formatted JSON for structured results.
- The original run output is currently read-only.

### Generated files

- Generated files are stored in the `artifacts` table and private artifact
  storage.
- Supported formats are PDF, DOCX, PPTX, XLSX, HTML, Markdown, TXT, CSV, and
  JSON.
- An artifact belongs to exactly one task or workflow run.
- Only one artifact row may exist per source run and format.
- `src/artifacts/service.ts` currently regenerates files from the original
  task or workflow output.
- `source_hash` records the source content used to generate a file.
- HTML uses a static sandbox preview. Scripts, forms, external requests, and
  navigation are disabled.
- Office files download to their native applications; Woody does not preview
  or edit their internal structures.

### Current UI

- Completed task output appears in the agent workspace through
  `ExecutionDetail`.
- `ArtifactPanel` lists generated files and supports generation, HTML viewing,
  PDF preview, download, refresh, and deletion.
- There is no Edit, Save revision, Version history, Revert, or Regenerate from
  revision flow.

## Important Existing Files

### Frontend

- `web-stitch/src/features/execution/ExecutionPage.tsx`
  - Completed output and artifact controls.
- `web-stitch/src/components/OutputViewer.tsx`
  - Shared Markdown/JSON rendering.
- `web-stitch/src/components/files/HtmlArtifactPreview.tsx`
  - Sandboxed static HTML preview.
- `web-stitch/src/components/files/OutputFormatPicker.tsx`
  - Downloadable format selection.
- `web-stitch/src/api.ts`
  - Task, artifact, and file API types and calls.

### Backend

- `src/worker.ts`
  - Persists the original agent result.
- `src/routes/tasks.ts`
  - Returns task details, output, events, attachments, and artifacts.
- `src/routes/artifacts.ts`
  - Requests, downloads, and deletes artifacts.
- `src/artifacts/service.ts`
  - Resolves source content and generates derivative files.
- `src/artifacts/storage.ts`
  - Private artifact storage adapter.
- `src/artifacts/types.ts`
  - Artifact formats and source-text normalization.
- `src/db/migrations/017_artifacts_and_workflow_runtime.sql`
  - Original artifact schema.
- `src/db/migrations/026_unified_file_intelligence.sql`
  - Expanded artifact formats.

## Non-Negotiable Safety Boundaries

- Never overwrite or delete the original agent/workflow output when a user
  edits a result.
- Never treat edited HTML as trusted application code.
- Continue to preview HTML in a scriptless sandbox with no external network,
  forms, navigation, or parent-page access.
- Never expose storage keys, filesystem paths, credentials, or provider
  secrets to the frontend.
- Enforce workspace ownership and member roles on every read and write.
- Use explicit save/revert actions for durable changes.
- Use optimistic concurrency so two open editors cannot silently overwrite one
  another.
- Record editor identity, timestamp, source revision, and regeneration events
  in the audit log.
- A file generated from an older revision must be visibly marked outdated.
- Regeneration must never silently replace a ready download while another
  generation is still running.

## Recommended Working Architecture

This is a planning hypothesis and still requires user approval.

### Immutable run evidence

Keep `tasks.output` and `workflow_runs.output` unchanged. They remain the
historical record of what the agent actually returned.

### Editable output document

Create a separate versioned output-document domain:

- One output document per task or workflow run.
- The first version is initialized from the original run output.
- Each explicit save creates a new immutable version.
- One version is marked current.
- Revert creates another version copied from an older one; it does not delete
  history.

Suggested conceptual records:

- `output_documents`
  - workspace and source-run identity
  - current version
  - title and lifecycle timestamps
- `output_document_versions`
  - document ID
  - version number
  - canonical Markdown content
  - optional structured metadata
  - content hash
  - editor identity and timestamps

### One canonical source

Use Markdown as the canonical editable source in the first release.

- The editor shows Markdown source and a rendered preview.
- HTML is generated from the current Markdown revision using the selected HTML
  template.
- PDF, Word, PowerPoint, Excel, and other formats are derivatives.
- This avoids having Markdown and HTML diverge into two competing sources of
  truth.

Direct low-level HTML source editing should remain a later advanced feature
unless the user explicitly chooses it as a first-release requirement.

### Revision-aware artifacts

Each generated artifact should record the output-document version and content
hash it came from.

- Current: artifact hash matches the selected revision.
- Outdated: artifact belongs to an older revision.
- Generating: replacement is being built.
- Failed: the previous ready file remains available while the failure is
  shown separately.

The generation service should read the selected saved revision rather than
reading `tasks.output` or `workflow_runs.output` directly.

## Intended User Experience

### Default completed-output view

- Rendered result remains the primary view.
- Add a clear **Edit output** action.
- Show a small revision indicator, such as `Version 3 · saved 10 minutes ago`.
- Preserve generated file controls below the result.

### Editor

- Split view on desktop:
  - left: Markdown editor
  - right: live rendered preview
- Tabs or a stacked layout on smaller screens.
- Visible Save new version, Cancel, and Version history actions.
- Unsaved-change warning before closing or navigating away.
- Character count and approximate prompt-token count are informational only.
- Saving does not regenerate files automatically unless the user explicitly
  chooses that behavior.

### Version history

- Show version number, editor, timestamp, and optional change summary.
- Preview any prior version.
- Revert by creating a new current version.
- Do not allow destructive deletion of individual historical versions in the
  first release.

### Regeneration

- After saving, show which existing files are outdated.
- Let the user select formats and press **Regenerate selected**.
- Keep the previous ready file downloadable until its replacement succeeds.
- Clearly identify which revision each file represents.

## Error and Conflict Handling

- Validation error: keep the unsaved editor content and explain the exact
  limit or invalid input.
- Version conflict: stop the save, preserve the local draft, and offer Reload
  latest or Copy my draft.
- Generation failure: retain the last ready file and show a retry action.
- Source run missing: prevent document initialization and show a
  human-readable recovery message.
- Empty source: allow editing only after the user intentionally starts a blank
  document.
- Network interruption: keep the unsaved draft in browser memory for the
  current session; durable offline drafts are out of first-release scope.

## First-Release Scope

Included:

- Completed task outputs.
- Versioned canonical Markdown.
- Rendered preview.
- Explicit save, cancel, history, and revert-as-new-version.
- Revision-aware regeneration for existing artifact formats.
- Outdated-file status.
- Workspace authorization, audit events, concurrency checks, and safe HTML
  preview.
- Responsive and accessible editor behavior.

Deferred:

- Native DOCX, PPTX, or XLSX editing.
- Collaborative real-time cursors.
- Comments and approval workflows on individual paragraphs.
- Arbitrary JavaScript or interactive HTML.
- AI rewriting inside the editor.
- Offline durable drafts.
- Editing running or failed task output.

## Open Decisions

The following choices must be confirmed during design:

1. Whether every save creates a new version or the user can overwrite the
   current working version.
2. Whether saving should automatically regenerate previously requested files
   or require an explicit regeneration action.
3. Whether editable output should launch for task results only in phase one,
   or for workflow-run results at the same time.
4. Whether change summaries are written manually, generated automatically, or
   omitted in the first release.

## Definition of Done for Future Implementation

- The original run output remains unchanged after editing.
- A user can create, preview, save, revisit, and revert output revisions.
- Concurrent edits cannot silently overwrite each other.
- Every generated file identifies its source revision.
- Outdated files are obvious and can be regenerated explicitly.
- Failed regeneration does not destroy the last valid download.
- Unauthorized workspaces cannot read or modify documents or revisions.
- HTML remains sandboxed and inactive.
- Focused backend tests, database-backed integration tests, frontend build,
  lint, and browser verification pass.
- The deployed feature is available only on the maintained port 3002
  frontend.
