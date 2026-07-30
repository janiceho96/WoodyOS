import { describe, expect, it } from 'vitest';
import { deduplicateDisplayCitations } from '../src/files/context.js';

describe('Copilot citation display deduplication', () => {
  it('returns one display citation per file and locator', () => {
    const result = deduplicateDisplayCitations([
      { fileId: 'f1', filename: 'resume.pdf', locator: 'Page 1', content: 'a', score: 0.1 },
      { fileId: 'f1', filename: 'resume.pdf', locator: 'Page 1', content: 'b', score: 0.7 },
      { fileId: 'f1', filename: 'resume.pdf', locator: 'Page 2', content: 'c', score: 0.3 },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ locator: 'Page 1', score: 0.7 });
  });
});
