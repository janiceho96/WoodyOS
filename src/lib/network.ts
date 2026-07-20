import { isIP } from 'node:net';

/** Returns false for private, loopback, link-local, documentation, multicast, and reserved addresses. */
export function isPublicIp(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168)) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0) return false;
    return true;
  }
  if (family === 6) {
    const normalised = address.toLowerCase();
    if (normalised === '::' || normalised === '::1' || normalised.startsWith('fc') || normalised.startsWith('fd') || normalised.startsWith('fe80:') || normalised.startsWith('ff')) return false;
    const mapped = normalised.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    if (normalised.startsWith('2001:db8:')) return false;
    return true;
  }
  return false;
}
