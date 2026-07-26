import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultRetention, inspectUpload, safeOriginalName } from '../src/files/types.js';
import { LocalPrivateFileStorage } from '../src/files/storage.js';
import { secureLinkAdapter } from '../src/files/imports/secure-link.js';
import { htmlThemeFromDesignMarkdown } from '../src/artifacts/template.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('unified private files', () => {
  it('validates filename, extension, MIME, and real file signatures', () => {
    const pdf = Buffer.from('%PDF-1.7\nsafe');
    expect(inspectUpload('../../Quarterly Report.pdf', 'application/pdf', pdf)).toMatchObject({
      name: 'Quarterly Report.pdf',
      extension: 'pdf',
      mimeType: 'application/pdf',
    });
    const pptxPackage = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('safe-ppt/slide1.xml')]);
    expect(inspectUpload('review.pptx', 'application/octet-stream', pptxPackage).extension).toBe('pptx');
    expect(() => inspectUpload('fake.pdf', 'application/pdf', Buffer.from('not a PDF'))).toThrow('FILE_SIGNATURE_MISMATCH');
    expect(() => inspectUpload('program.exe', 'application/octet-stream', Buffer.from('MZ'))).toThrow('FILE_TYPE_UNSUPPORTED');
    expect(safeOriginalName('../\u0000notes.txt')).toBe('notes.txt');
  });

  it('defaults transient task and conversation files to bounded retention', () => {
    expect(defaultRetention('task')).toMatchObject({ policy: '30_days', expiresAt: expect.any(Date) });
    expect(defaultRetention('conversation')).toMatchObject({ policy: '30_days', expiresAt: expect.any(Date) });
    expect(defaultRetention('saved')).toEqual({ policy: 'keep', expiresAt: null });
    expect(defaultRetention('knowledge')).toEqual({ policy: 'keep', expiresAt: null });
  });

  it('keeps uploaded binaries inside a private workspace root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'woody-files-')); temporary.push(root);
    const storage = new LocalPrivateFileStorage(root);
    const key = '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002.pdf';
    await storage.put(key, Buffer.from('%PDF-private'));
    expect((await storage.read(key)).toString()).toBe('%PDF-private');
    await expect(storage.put('../escape.pdf', Buffer.from('bad'))).rejects.toThrow('INVALID_FILE_STORAGE_KEY');
    await storage.delete(key);
    await expect(storage.read(key)).rejects.toThrow();
  });

  it('blocks cloud imports from local and private network addresses', async () => {
    await expect(secureLinkAdapter.download({
      url: 'https://127.0.0.1/report.pdf',
      scope: 'saved',
    })).rejects.toThrow('CLOUD_IMPORT_PRIVATE_ADDRESS_BLOCKED');
  });

  it('turns DESIGN.md into bounded safe HTML tokens', () => {
    expect(htmlThemeFromDesignMarkdown(`
# Output
- Background: #101827
- Accent: #22D3EE
- Headings: Georgia
- Body font: JetBrains Mono
- Density: compact
`)).toMatchObject({
      background: '#101827',
      accent: '#22D3EE',
      headingFont: 'serif',
      bodyFont: 'mono',
      density: 'compact',
    });
    expect(htmlThemeFromDesignMarkdown('- Accent: url(https://bad.test)')).toMatchObject({ accent: '#8B7CFF' });
  });
});
