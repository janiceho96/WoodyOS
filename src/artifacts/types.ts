import { ARTIFACT_FORMATS, artifactFormatSchema, artifactRegistry, type ArtifactFormat } from './registry.js';
export { ARTIFACT_FORMATS, artifactFormatSchema, artifactRegistry, type ArtifactFormat } from './registry.js';

export const artifactFormatInfo = artifactRegistry;

export type ArtifactRecord = {
  id: string;
  workspace_id: string;
  task_id: string | null;
  workflow_run_id: string | null;
  output_document_version_id: string | null;
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
    if (typeof record.content === 'string') return record.content;
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
  if (/\b(html|web page|static webpage)\b/.test(normalized)) formats.push('html');
  if (/\b(markdown file|\\.md file)\b/.test(normalized)) formats.push('md');
  if (/\b(plain text|\\.txt file|text file)\b/.test(normalized)) formats.push('txt');
  if (/\b(csv|comma[- ]separated)\b/.test(normalized)) formats.push('csv');
  if (/\b(json|machine[- ]readable json)\b/.test(normalized)) formats.push('json');
  return formats;
}
