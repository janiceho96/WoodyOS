import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptJson, decryptJsonWithContext, encryptJson, encryptJsonWithContext } from '../src/lib/crypto.js';

describe('credential encryption contexts', () => {
  const previousKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
    delete process.env.ENCRYPTION_KEYS;
    delete process.env.ENCRYPTION_KEY_ID;
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousKey;
  });

  it('keeps existing version-one tool ciphertext readable', () => {
    const payload = encryptJson({ token: 'old-secret' });
    expect(decryptJson(payload)).toEqual({ token: 'old-secret' });
  });

  it('binds MCP ciphertext to its workspace and connection', () => {
    const payload = encryptJsonWithContext({ token: 'new-secret' }, 'workspace-a:connection-a');
    expect(decryptJsonWithContext(payload, 'workspace-a:connection-a')).toEqual({ token: 'new-secret' });
    expect(() => decryptJsonWithContext(payload, 'workspace-b:connection-a')).toThrow();
  });
});
