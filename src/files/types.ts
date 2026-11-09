import { basename, extname } from 'node:path';

export const SUPPORTED_FILE_EXTENSIONS = ['pdf', 'docx', 'pptx', 'xlsx', 'xlsm', 'csv', 'md', 'txt', 'html', 'png', 'jpg', 'jpeg', 'webp'] as const;
export type SupportedFileExtension = typeof SUPPORTED_FILE_EXTENSIONS[number];
export type FileScope = 'task' | 'conversation' | 'saved' | 'knowledge';
export type RetentionPolicy = 'keep' | '30_days' | 'delete_after_task' | 'delete_after_conversation';
export type FileStatus = 'scanning' | 'extracting' | 'ready' | 'failed';

export type FileRecord = {
  id: string;
  workspace_id: string;
  uploaded_by: string | null;
  original_name: string;
  extension: SupportedFileExtension;
  mime_type: string;
  size_bytes: string | number;
  sha256: string;
  storage_provider: string;
  storage_key: string;
  status: FileStatus;
  scan_status: 'pending' | 'not_configured' | 'clean' | 'infected' | 'failed';
  scope: FileScope;
  retention_policy: RetentionPolicy;
  expires_at: Date | string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  version_group_id: string;
  version_number: number;
  replaces_file_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
};

const canonicalMime: Record<SupportedFileExtension, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  csv: 'text/csv',
  md: 'text/markdown',
  txt: 'text/plain',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const textualExtensions = new Set<SupportedFileExtension>(['csv', 'md', 'txt', 'html']);

function looksLikeZip(buffer: Buffer, marker: string) {
  return buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && buffer.includes(Buffer.from(marker));
}

function looksTextual(buffer: Buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  return !sample.includes(0);
}

const signatureChecks: Record<SupportedFileExtension, (buffer: Buffer) => boolean> = {
  pdf: (buffer) => buffer.subarray(0, 5).toString() === '%PDF-',
  docx: (buffer) => looksLikeZip(buffer, 'word/'),
  pptx: (buffer) => looksLikeZip(buffer, 'ppt/'),
  xlsx: (buffer) => looksLikeZip(buffer, 'xl/'),
  xlsm: (buffer) => looksLikeZip(buffer, 'xl/'),
  csv: looksTextual,
  md: looksTextual,
  txt: looksTextual,
  html: looksTextual,
  png: (buffer) => buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  jpg: looksLikeJpeg,
  jpeg: looksLikeJpeg,
  webp: (buffer) => buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP',
};

function looksLikeJpeg(buffer: Buffer) {
  return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
}

function mimeMatches(extension: SupportedFileExtension, declaredMime: string, expectedMime: string) {
  if (declaredMime === expectedMime) return true;
  if (textualExtensions.has(extension) && declaredMime.startsWith('text/')) return true;
  return (extension === 'jpg' || extension === 'jpeg') && declaredMime === 'image/jpeg';
}

export function safeOriginalName(value: string) {
  const clean = basename(value).normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean.slice(0, 260) || 'upload';
}

export function inspectUpload(filename: string, declaredMime: string, buffer: Buffer) {
  if (!buffer.length) throw Object.assign(new Error('FILE_EMPTY'), { statusCode: 400 });
  if (buffer.length > 25 * 1024 * 1024) throw Object.assign(new Error('FILE_TOO_LARGE'), { statusCode: 413 });
  const name = safeOriginalName(filename);
  const extension = extname(name).slice(1).toLowerCase() as SupportedFileExtension;
  if (!SUPPORTED_FILE_EXTENSIONS.includes(extension)) throw Object.assign(new Error('FILE_TYPE_UNSUPPORTED'), { statusCode: 415 });

  if (!signatureChecks[extension](buffer)) throw Object.assign(new Error('FILE_SIGNATURE_MISMATCH'), { statusCode: 415 });

  const expectedMime = canonicalMime[extension];
  const normalizedDeclared = declaredMime.split(';')[0].trim().toLowerCase();
  if (normalizedDeclared && normalizedDeclared !== 'application/octet-stream' && !mimeMatches(extension, normalizedDeclared, expectedMime)) {
    throw Object.assign(new Error('FILE_MIME_MISMATCH'), { statusCode: 415 });
  }
  return { name, extension, mimeType: expectedMime };
}

export function defaultRetention(scope: FileScope): { policy: RetentionPolicy; expiresAt: Date | null } {
  if (scope === 'task' || scope === 'conversation') {
    const expiresAt = new Date();
    expiresAt.setUTCDate(expiresAt.getUTCDate() + 30);
    return { policy: '30_days', expiresAt };
  }
  return { policy: 'keep', expiresAt: null };
}
