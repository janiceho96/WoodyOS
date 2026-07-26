import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentAvatarSchema } from '../src/agents/avatar.js';
import { LocalAgentAvatarStorage } from '../src/avatars/storage.js';
import { validateAgentAvatarUpload } from '../src/avatars/service.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const assetId = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('agent avatars', () => {
  it('accepts only bounded built-in configurations', () => {
    expect(agentAvatarSchema.parse({ type: 'icon', value: 'search', backgroundColor: '#312e81' })).toMatchObject({ value: 'search' });
    expect(agentAvatarSchema.parse({ type: 'icon', value: 'agent' })).toMatchObject({ type: 'icon', value: 'agent' });
    expect(agentAvatarSchema.parse({ type: 'brand', value: 'notion', backgroundColor: '#312e81' })).toMatchObject({ type: 'brand', value: 'notion' });
    for (const value of ['linear', 'stripe', 'google-drive', 'gmail', 'reddit']) {
      expect(agentAvatarSchema.parse({ type: 'brand', value })).toMatchObject({ type: 'brand', value });
    }
    expect(() => agentAvatarSchema.parse({ type: 'brand', value: 'remote-provider' })).toThrow();
    expect(() => agentAvatarSchema.parse({ type: 'icon', value: 'remote-script' })).toThrow();
    expect(() => agentAvatarSchema.parse({ type: 'initials', value: '<img>' })).toThrow();
    expect(() => agentAvatarSchema.parse({ type: 'image', value: 'https://example.com/tracker.png' })).toThrow();
  });

  it('rejects unsupported and oversized image uploads before processing', () => {
    expect(() => validateAgentAvatarUpload('image/svg+xml', 500)).toThrow('AGENT_AVATAR_TYPE_UNSUPPORTED');
    expect(() => validateAgentAvatarUpload('image/png', 2 * 1024 * 1024 + 1)).toThrow('AGENT_AVATAR_TOO_LARGE');
    expect(() => validateAgentAvatarUpload('image/webp', 1_024)).not.toThrow();
  });

  it('keeps local media inside its private root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'woody-avatar-'));
    roots.push(root);
    const storage = new LocalAgentAvatarStorage(root);
    const key = `${workspaceId}/${assetId}.webp`;
    await storage.put(key, Buffer.from('normalized-webp'));
    const file = await storage.open(key);
    expect(file.size).toBe(15);
    for await (const _chunk of file.stream) { /* consume the stream before cleanup */ }
    expect(() => storage.open('../outside.webp')).rejects.toThrow('INVALID_AGENT_AVATAR_STORAGE_KEY');
    await storage.delete(key);
    await expect(storage.open(key)).rejects.toThrow();
  });
});
