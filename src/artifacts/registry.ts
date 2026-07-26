import { z } from 'zod';

export const ARTIFACT_FORMATS = ['pdf', 'docx', 'pptx', 'xlsx', 'html', 'md', 'txt', 'csv', 'json'] as const;
export const artifactFormatSchema = z.enum(ARTIFACT_FORMATS);
export type ArtifactFormat = z.infer<typeof artifactFormatSchema>;

export type ArtifactDefinition = {
  format: ArtifactFormat;
  label: string;
  mimeType: string;
  category: 'document' | 'presentation' | 'data' | 'web';
  preview: 'pdf' | 'html' | 'text' | 'none';
};

export const artifactRegistry: Record<ArtifactFormat, ArtifactDefinition> = {
  pdf: { format: 'pdf', label: 'PDF', mimeType: 'application/pdf', category: 'document', preview: 'pdf' },
  docx: { format: 'docx', label: 'Word', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', category: 'document', preview: 'none' },
  pptx: { format: 'pptx', label: 'PowerPoint', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', category: 'presentation', preview: 'none' },
  xlsx: { format: 'xlsx', label: 'Excel', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', category: 'data', preview: 'none' },
  html: { format: 'html', label: 'Web page', mimeType: 'text/html; charset=utf-8', category: 'web', preview: 'html' },
  md: { format: 'md', label: 'Markdown', mimeType: 'text/markdown; charset=utf-8', category: 'document', preview: 'text' },
  txt: { format: 'txt', label: 'Plain text', mimeType: 'text/plain; charset=utf-8', category: 'document', preview: 'text' },
  csv: { format: 'csv', label: 'CSV', mimeType: 'text/csv; charset=utf-8', category: 'data', preview: 'text' },
  json: { format: 'json', label: 'JSON', mimeType: 'application/json; charset=utf-8', category: 'data', preview: 'text' },
};
