import { describe, expect, it } from 'vitest';
import {
  classifyArtifactRevision,
  createOutputContentHash,
  outputContentSchema,
} from '../src/outputs/types.js';

describe('editable output contracts', () => {
  it('validates bounded non-empty Markdown', () => {
    expect(outputContentSchema.parse('# Revised result')).toBe('# Revised result');
    expect(outputContentSchema.safeParse('   ').success).toBe(false);
    expect(outputContentSchema.safeParse('x'.repeat(100_001)).success).toBe(false);
  });

  it('creates stable content hashes', () => {
    expect(createOutputContentHash('# Result')).toMatch(/^[a-f0-9]{64}$/);
    expect(createOutputContentHash('# Result')).toBe(createOutputContentHash('# Result'));
  });

  it('classifies current, outdated and original artifacts', () => {
    expect(classifyArtifactRevision('v2', 'v2')).toBe('current');
    expect(classifyArtifactRevision('v1', 'v2')).toBe('outdated');
    expect(classifyArtifactRevision(null, 'v2')).toBe('original');
  });
});
