import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { artifactTitle, inferredArtifactFormats, outputText } from '../src/artifacts/types.js';
import { LocalArtifactStorage } from '../src/artifacts/storage.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('artifact requests and storage', () => {
  it('detects explicit requested formats without confusing input-file mentions', () => {
    expect(inferredArtifactFormats('Deliver the final report as PDF, PowerPoint and Excel.')).toEqual(['pdf', 'pptx', 'xlsx']);
    expect(inferredArtifactFormats('Read the attached PDF and summarize it.')).toEqual([]);
    expect(inferredArtifactFormats('Create a Word document for the client.')).toEqual(['docx']);
  });

  it('normalizes filenames and output text', () => {
    expect(artifactTitle('Quarterly / Review?', 'pdf')).toBe('Quarterly-Review.pdf');
    expect(outputText({ text: '# Result' })).toBe('# Result');
    expect(outputText({ value: 4 })).toContain('"value": 4');
  });

  it('writes atomically under a workspace-scoped safe key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'woody-artifacts-')); temporary.push(root);
    const storage = new LocalArtifactStorage(root);
    const key = '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002.pdf';
    await storage.put(key, Buffer.from('%PDF-test'));
    expect(await readFile(join(root, key), 'utf8')).toBe('%PDF-test');
    await expect(storage.put('../escape.pdf', Buffer.from('bad'))).rejects.toThrow('INVALID_ARTIFACT_STORAGE_KEY');
    await storage.delete(key);
  });
});
