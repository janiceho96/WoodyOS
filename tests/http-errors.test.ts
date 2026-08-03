import { describe, expect, it } from 'vitest';
import { publicErrorCode } from '../src/lib/http.js';

describe('public HTTP error boundary', () => {
  it('keeps safe domain codes while hiding arbitrary provider detail', () => {
    expect(publicErrorCode(new Error('COPILOT_CONTEXT_STALE'), 409)).toBe('COPILOT_CONTEXT_STALE');
    expect(publicErrorCode(new Error('provider key=secret-value'), 409)).toBe('REQUEST_FAILED');
    expect(publicErrorCode(new Error('database password=secret-value'), 500)).toBe('INTERNAL_ERROR');
  });

  it('preserves human MCP availability guidance without exposing stack data', () => {
    const error = Object.assign(new Error('This MCP app requires the desktop bridge.'), {
      name: 'McpError',
      code: 'MCP_CURATED_APP_UNAVAILABLE',
      statusCode: 422,
    });
    expect(publicErrorCode(error, 422)).toBe('This MCP app requires the desktop bridge.');
  });
});
