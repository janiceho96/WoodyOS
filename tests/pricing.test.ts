import { describe, expect, it } from 'vitest';
import { estimateClaudeCostUsd } from '../src/lib/pricing.js';

describe('Claude cost estimates', () => {
  it('calculates Sonnet 4 token cost using current base rates', () => {
    expect(estimateClaudeCostUsd('claude-sonnet-4-20250514', 1_000_000, 1_000_000)).toBe(18);
  });

  it('returns zero for a model without a known price', () => {
    expect(estimateClaudeCostUsd('custom-model', 100, 100)).toBe(0);
  });
});
