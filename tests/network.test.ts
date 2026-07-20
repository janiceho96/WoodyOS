import { describe, expect, it } from 'vitest';
import { isPublicIp } from '../src/lib/network.js';

describe('public network guard', () => {
  it('accepts globally routable addresses', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('2606:4700:4700::1111')).toBe(true);
  });

  it('blocks private, link-local, mapped, and reserved addresses', () => {
    for (const address of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.168.1.1', '198.18.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1']) {
      expect(isPublicIp(address), address).toBe(false);
    }
  });
});
