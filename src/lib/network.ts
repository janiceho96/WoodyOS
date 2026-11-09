import { isIP } from 'node:net';

const blockedIpv4Ranges: ReadonlyArray<readonly [bigint, number]> = [
  [0x00000000n, 8], // Current network
  [0x0a000000n, 8], // Private use
  [0x64400000n, 10], // Shared address space
  [0x7f000000n, 8], // Loopback
  [0xa9fe0000n, 16], // Link-local
  [0xac100000n, 12], // Private use
  [0xc0000000n, 24], // IETF protocol assignments
  [0xc0000200n, 24], // Documentation
  [0xc0586300n, 24], // 6to4 relay anycast
  [0xc0a80000n, 16], // Private use
  [0xc6120000n, 15], // Benchmarking
  [0xc6336400n, 24], // Documentation
  [0xcb007100n, 24], // Documentation
  [0xe0000000n, 4], // Multicast
  [0xf0000000n, 4], // Reserved
];

const globalIpv6Range = 0x20000000000000000000000000000000n;
const blockedIpv6Ranges: ReadonlyArray<readonly [bigint, number]> = [
  [0x20010000000000000000000000000000n, 23], // IETF protocol assignments
  [0x20010db8000000000000000000000000n, 32], // Documentation
  [0x20020000000000000000000000000000n, 16], // 6to4
  [0x3fff0000000000000000000000000000n, 20], // Documentation
];

function hasIpv4Prefix(address: bigint, network: bigint, prefix: number) {
  const shift = BigInt(32 - prefix);
  return (address >> shift) === (network >> shift);
}

function hasIpv6Prefix(address: bigint, network: bigint, prefix: number) {
  const shift = BigInt(128 - prefix);
  return (address >> shift) === (network >> shift);
}

function ipv4Value(address: string) {
  return address.split('.').reduce((value, octet) => value * 256n + BigInt(octet), 0n);
}

function isPublicIpv4Value(address: bigint) {
  return !blockedIpv4Ranges.some(([network, prefix]) => hasIpv4Prefix(address, network, prefix));
}

function ipv6Value(address: string) {
  let normalized = address.toLowerCase();
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const embeddedIpv4 = ipv4Value(normalized.slice(lastColon + 1));
    const highGroup = (embeddedIpv4 >> 16n).toString(16);
    const lowGroup = (embeddedIpv4 & 0xffffn).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${highGroup}:${lowGroup}`;
  }

  const [left = '', right] = normalized.split('::');
  const leftGroups = left ? left.split(':') : [];
  const rightGroups = right ? right.split(':') : [];
  const zeroGroups = Array(8 - leftGroups.length - rightGroups.length).fill('0') as string[];
  const groups = [...leftGroups, ...zeroGroups, ...rightGroups];
  return groups.reduce((value, group) => (value << 16n) + BigInt(`0x${group || '0'}`), 0n);
}

/** Returns false for private, loopback, link-local, documentation, multicast, and reserved addresses. */
export function isPublicIp(address: string) {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4Value(ipv4Value(address));
  if (family !== 6) return false;

  const value = ipv6Value(address);
  const mappedIpv4Prefix = value >> 32n;
  if (mappedIpv4Prefix === 0xffffn) return isPublicIpv4Value(value & 0xffffffffn);

  if (!hasIpv6Prefix(value, globalIpv6Range, 3)) return false;
  return !blockedIpv6Ranges.some(([network, prefix]) => hasIpv6Prefix(value, network, prefix));
}
