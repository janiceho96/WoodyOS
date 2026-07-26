import { createHash } from 'node:crypto';
import { z } from 'zod';

export const outputContentSchema = z.string()
  .min(1)
  .max(100_000)
  .refine((content) => content.trim().length > 0, 'Output content cannot be blank');

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
