import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('workflow compiler proxy', () => {
  it('allows reasoning models enough time to finish complex workflow plans', () => {
    const nginx = readFileSync(new URL('../web-stitch/nginx.conf', import.meta.url), 'utf8');
    const compileLocation = nginx.match(
      /location = \/v1\/agent-solutions\/compile \{([\s\S]*?)\n  \}/,
    )?.[1] ?? '';

    expect(compileLocation).toContain('proxy_read_timeout 300s;');
    expect(compileLocation).toContain('proxy_send_timeout 300s;');
  });
});
