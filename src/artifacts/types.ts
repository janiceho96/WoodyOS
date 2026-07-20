import { z } from 'zod';

export const artifactFormatSchema = z.enum(['pdf', 'docx', 'pptx', 'xlsx']);
export type ArtifactFormat = z.infer<typeof artifactFormatSchema>;

export const ARTIFACT_FORMATS = artifactFormatSchema.options;

export const artifactFormatInfo: Record<ArtifactFormat, { mimeType: string; label: string }> = {
  pdf: { mimeType: 'application/pdf', label: 'PDF' },
  docx: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word' },
  pptx: { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PowerPoint' },
  xlsx: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel' },
};

export type ArtifactRecord = {
  id: string;
  workspace_id: string;
  task_id: string | null;
  workflow_run_id: string | null;
  created_by: string | null;
  format: ArtifactFormat;
  status: 'pending' | 'queued' | 'generating' | 'ready' | 'failed' | 'skipped';
  filename: string;
  mime_type: string;
  storage_provider: string;
  storage_key: string | null;
  size_bytes: string | number | null;
  sha256: string | null;
  source_hash: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
};

export function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
  }
  return JSON.stringify(value ?? {}, null, 2);
}

export function artifactTitle(title: string, format: ArtifactFormat) {
  const stem = title
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9\s_-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 90) || 'woody-output';
  return `${stem}.${format}`;
}

export function inferredArtifactFormats(text: string): ArtifactFormat[] {
  const normalized = text.toLowerCase();
  const asksForFile = /(export|output|deliver|download|generate|create|provide|give|save|return|convert|turn).{0,40}\b(as|into|in|to)\b/.test(normalized)
    || /\b(make|create|generate)\s+(a|an|the)?\s*(pdf|powerpoint|presentation|spreadsheet|excel|word document)/.test(normalized);
  if (!asksForFile) return [];
  const formats: ArtifactFormat[] = [];
  if (/\bpdf\b/.test(normalized)) formats.push('pdf');
  if (/\b(docx|word document|microsoft word)\b/.test(normalized)) formats.push('docx');
  if (/\b(pptx|powerpoint|slide deck|presentation)\b/.test(normalized)) formats.push('pptx');
  if (/\b(xlsx|excel|spreadsheet|workbook)\b/.test(normalized)) formats.push('xlsx');
  return formats;
}
