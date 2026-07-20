import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type EncryptedPayloadV1 = { version: 1; iv: string; tag: string; data: string };
export type EncryptedPayloadV2 = { version: 2; keyId: string; iv: string; tag: string; data: string };
export type EncryptedPayload = EncryptedPayloadV1 | EncryptedPayloadV2;

function key(keyId = process.env.ENCRYPTION_KEY_ID ?? 'default') {
  let value = process.env.ENCRYPTION_KEY;
  if (process.env.ENCRYPTION_KEYS) {
    let keyring: Record<string, unknown>;
    try {
      keyring = JSON.parse(process.env.ENCRYPTION_KEYS) as Record<string, unknown>;
    } catch {
      throw Object.assign(new Error('ENCRYPTION_KEYS must be a JSON object of base64-encoded keys'), { statusCode: 503 });
    }
    value = typeof keyring[keyId] === 'string' ? keyring[keyId] : undefined;
  }
  if (!value) throw Object.assign(new Error('ENCRYPTION_KEY must be configured before storing tool credentials'), { statusCode: 503 });
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32) throw Object.assign(new Error('ENCRYPTION_KEY must be a base64-encoded 32-byte key'), { statusCode: 503 });
  return decoded;
}

export function encryptJson(value: Record<string, unknown>): EncryptedPayloadV1 {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function decryptJson(payload: EncryptedPayloadV1): Record<string, unknown> {
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8')) as Record<string, unknown>;
}

export function encryptJsonWithContext(value: Record<string, unknown>, context: string): EncryptedPayloadV2 {
  const keyId = process.env.ENCRYPTION_KEY_ID ?? 'default';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(keyId), iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    version: 2,
    keyId,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decryptJsonWithContext(payload: EncryptedPayload, context: string): Record<string, unknown> {
  if (payload.version === 1) return decryptJson(payload);
  const decipher = createDecipheriv('aes-256-gcm', key(payload.keyId), Buffer.from(payload.iv, 'base64'));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8')) as Record<string, unknown>;
}
