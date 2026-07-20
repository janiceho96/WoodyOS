import { createHash } from 'node:crypto';
import { query } from '../db/client.js';
import { enqueueArtifact } from '../queue/task-queue.js';
import { artifactStorage } from './storage.js';
import { artifactFormatInfo, artifactTitle, outputText, type ArtifactFormat, type ArtifactRecord } from './types.js';
import type { PresentationTheme } from '../presentations/theme.js';

type ArtifactSource = { title: string; output: unknown; created_by: string | null; status: string };

async function enqueuePreparedArtifacts(records: ArtifactRecord[]) {
  const results = await Promise.allSettled(records.map((artifact) => enqueueArtifact(artifact.id, `${artifact.id}:${Date.now()}`)));
  const failures = results.flatMap((result, index) => result.status === 'rejected' ? [{ artifact: records[index], error: result.reason }] : []);
  await Promise.all(failures.map(({ artifact, error }) => query(
    "UPDATE artifacts SET status='failed',error_message=$1,updated_at=now() WHERE id=$2 AND status='queued'",
    [(error instanceof Error ? error.message : 'Artifact queue unavailable').slice(0, 2000), artifact.id],
  )));
  if (failures.length) throw new AggregateError(failures.map(({ error }) => error), `Could not queue ${failures.length} artifact${failures.length === 1 ? '' : 's'}`);
}

async function sourceFor(artifact: ArtifactRecord): Promise<ArtifactSource> {
  if (artifact.task_id) {
    const row = (await query<ArtifactSource>('SELECT title,output,requested_by created_by,status FROM tasks WHERE id=$1 AND workspace_id=$2', [artifact.task_id, artifact.workspace_id])).rows[0];
    if (!row) throw new Error('ARTIFACT_TASK_SOURCE_MISSING');
    if (row.status !== 'completed') throw new Error('ARTIFACT_TASK_NOT_COMPLETED');
    return row;
  }
  const row = (await query<ArtifactSource>(
    `SELECT w.name title,r.output,w.created_by,r.status
       FROM workflow_runs r JOIN workflows w ON w.id=r.workflow_id
      WHERE r.id=$1 AND r.workspace_id=$2`,
    [artifact.workflow_run_id, artifact.workspace_id],
  )).rows[0];
  if (!row) throw new Error('ARTIFACT_WORKFLOW_SOURCE_MISSING');
  if (row.status !== 'completed') throw new Error('ARTIFACT_WORKFLOW_NOT_COMPLETED');
  return row;
}

function generatorUrl() {
  return `${(process.env.EXTRACTOR_URL ?? 'http://localhost:8000').replace(/\/$/, '')}/generate`;
}

export async function generateArtifact(artifactId: string) {
  const artifact = (await query<ArtifactRecord>(
    `UPDATE artifacts SET status='generating',error_message=NULL,updated_at=now()
      WHERE id=$1 AND status IN ('queued','generating','failed') RETURNING *`,
    [artifactId],
  )).rows[0];
  if (!artifact) return null;
  try {
    const source = await sourceFor(artifact);
    const content = outputText(source.output);
    if (!content.trim()) throw new Error('ARTIFACT_SOURCE_IS_EMPTY');
    const sourceHash = createHash('sha256').update(content).digest('hex');
    const theme = artifact.format === 'pptx'
      ? (await query<{ theme: PresentationTheme }>('SELECT theme FROM presentation_themes WHERE workspace_id=$1 AND is_default=true LIMIT 1', [artifact.workspace_id])).rows[0]?.theme ?? null
      : null;
    const response = await fetch(generatorUrl(), {
      method: 'POST',
      signal: AbortSignal.timeout(90_000),
      headers: {
        'content-type': 'application/json',
        ...(process.env.EXTRACTOR_TOKEN ? { authorization: `Bearer ${process.env.EXTRACTOR_TOKEN}` } : {}),
      },
      body: JSON.stringify({ format: artifact.format, title: source.title, content, theme }),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { detail?: string } | null;
      throw new Error(detail?.detail ?? `Artifact generator returned ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error('ARTIFACT_GENERATOR_RETURNED_EMPTY_FILE');
    if (bytes.length > 50 * 1024 * 1024) throw new Error('ARTIFACT_EXCEEDS_50_MB_LIMIT');
    const storage = artifactStorage();
    const key = `${artifact.workspace_id}/${artifact.id}.${artifact.format}`;
    await storage.put(key, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const ready = (await query<ArtifactRecord>(
      `UPDATE artifacts
          SET status='ready',storage_provider=$1,storage_key=$2,size_bytes=$3,sha256=$4,source_hash=$5,
              error_message=NULL,completed_at=now(),updated_at=now()
        WHERE id=$6 RETURNING *`,
      [storage.provider, key, bytes.length, sha256, sourceHash, artifact.id],
    )).rows[0];
    return ready;
  } catch (error) {
    const message = (error instanceof Error ? error.message : 'Artifact generation failed').slice(0, 2000);
    await query("UPDATE artifacts SET status='failed',error_message=$1,updated_at=now() WHERE id=$2", [message, artifact.id]);
    throw error;
  }
}

async function requestArtifacts(input: {
  workspaceId: string;
  createdBy: string | null;
  taskId?: string;
  workflowRunId?: string;
  title: string;
  formats: ArtifactFormat[];
  ready: boolean;
}) {
  const records: ArtifactRecord[] = [];
  const enqueueIds = new Set<string>();
  for (const format of [...new Set(input.formats)]) {
    const info = artifactFormatInfo[format];
    const inserted = (await query<ArtifactRecord>(
      `INSERT INTO artifacts(workspace_id,task_id,workflow_run_id,created_by,format,status,filename,mime_type)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING *`,
      [input.workspaceId, input.taskId ?? null, input.workflowRunId ?? null, input.createdBy, format, input.ready ? 'queued' : 'pending', artifactTitle(input.title, format), info.mimeType],
    )).rows[0];
    const selected = inserted ?? (await query<ArtifactRecord>(
      `SELECT * FROM artifacts WHERE workspace_id=$1 AND format=$2 AND
       (($3::uuid IS NOT NULL AND task_id=$3) OR ($4::uuid IS NOT NULL AND workflow_run_id=$4))`,
      [input.workspaceId, format, input.taskId ?? null, input.workflowRunId ?? null],
    )).rows[0];
    if (inserted && input.ready) enqueueIds.add(inserted.id);
    if (selected?.status === 'failed' || selected?.status === 'skipped' || (selected?.status === 'pending' && input.ready)) {
      const reset = (await query<ArtifactRecord>("UPDATE artifacts SET status=$1,error_message=NULL,updated_at=now() WHERE id=$2 RETURNING *", [input.ready ? 'queued' : 'pending', selected.id])).rows[0];
      if (reset) { records.push(reset); if (input.ready) enqueueIds.add(reset.id); }
    } else if (selected) records.push(selected);
  }
  if (input.ready) await enqueuePreparedArtifacts(records.filter((record) => enqueueIds.has(record.id)));
  return records;
}

export function requestTaskArtifacts(input: { workspaceId: string; createdBy: string | null; taskId: string; title: string; formats: ArtifactFormat[]; ready: boolean }) {
  return requestArtifacts(input);
}

export function requestWorkflowArtifacts(input: { workspaceId: string; createdBy: string | null; workflowRunId: string; title: string; formats: ArtifactFormat[]; ready: boolean }) {
  return requestArtifacts(input);
}

export async function releaseTaskArtifacts(taskId: string) {
  const rows = (await query<ArtifactRecord>("UPDATE artifacts SET status='queued',updated_at=now() WHERE task_id=$1 AND status='pending' RETURNING *", [taskId])).rows;
  await enqueuePreparedArtifacts(rows);
  return rows;
}
