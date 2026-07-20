import { describe, expect, it } from 'vitest';
import { parseProviderReset, providerQuotaFromHeaders } from '../src/lib/ai-usage.js';

describe('AI provider quota parsing', () => {
  it('parses OpenAI-compatible rate-limit headers without retaining unrelated headers', () => {
    const headers = new Headers({
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-remaining-requests': '42',
      'x-ratelimit-reset-requests': '30s',
      'x-ratelimit-limit-tokens': '100000',
      'x-ratelimit-remaining-tokens': '87500',
      authorization: 'Bearer must-never-be-stored',
    });
    const quota = providerQuotaFromHeaders(headers);
    expect(quota).toMatchObject({
      requestLimit: 100,
      requestsRemaining: 42,
      tokenLimit: 100000,
      tokensRemaining: 87500,
      creditRemainingUsd: null,
    });
    expect(quota?.requestsResetAt).toBeInstanceOf(Date);
    expect(JSON.stringify(quota)).not.toContain('must-never-be-stored');
  });

  it('parses Anthropic header names and an explicitly reported account balance', () => {
    const headers = new Headers({
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-requests-remaining': '12',
      'anthropic-ratelimit-tokens-limit': '50000',
      'anthropic-ratelimit-tokens-remaining': '9000',
      'x-balance-usd': '7.25',
    });
    expect(providerQuotaFromHeaders(headers)).toMatchObject({
      requestLimit: 50,
      requestsRemaining: 12,
      tokenLimit: 50000,
      tokensRemaining: 9000,
      creditRemainingUsd: 7.25,
    });
  });

  it('returns null when the provider supplies no recognized quota metadata', () => {
    expect(providerQuotaFromHeaders(new Headers({ 'x-request-id': 'request-1' }))).toBeNull();
  });

  it('parses duration and absolute reset values', () => {
    const now = new Date('2026-07-19T10:00:00.000Z');
    expect(parseProviderReset('1m30s', now)?.toISOString()).toBe('2026-07-19T10:01:30.000Z');
    expect(parseProviderReset('2026-07-19T11:00:00.000Z', now)?.toISOString()).toBe('2026-07-19T11:00:00.000Z');
  });
});

