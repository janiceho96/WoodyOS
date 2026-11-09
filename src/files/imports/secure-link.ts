import { lookup } from 'node:dns/promises';
import { basename } from 'node:path';
import { Agent, fetch } from 'undici';
import { safeOriginalName } from '../types.js';
import { isPublicIp } from '../../lib/network.js';
import type { CloudImportAdapter, CloudImportRequest, DownloadedCloudFile } from './types.js';

const MAX_BYTES = 25 * 1024 * 1024;

async function validatedAddresses(hostname: string) {
  const resolved = await lookup(hostname, { all: true, verbatim: true });
  if (!resolved.length || resolved.some((entry) => !isPublicIp(entry.address))) {
    throw Object.assign(new Error('CLOUD_IMPORT_PRIVATE_ADDRESS_BLOCKED'), { statusCode: 400 });
  }
  return resolved;
}

function filenameFrom(response: { headers: Headers }, url: URL, requested?: string) {
  if (requested?.trim()) return safeOriginalName(requested);
  const disposition = response.headers.get('content-disposition') ?? '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const basic = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  return safeOriginalName(
    (encoded ? decodeURIComponent(encoded) : basic)
    ?? basename(decodeURIComponent(url.pathname))
    ?? 'cloud-file',
  );
}

async function fetchPinned(url: URL) {
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw Object.assign(new Error('CLOUD_IMPORT_REQUIRES_PUBLIC_HTTPS'), { statusCode: 400 });
  }
  const addresses = await validatedAddresses(url.hostname);
  let cursor = 0;
  const dispatcher = new Agent({
    connect: {
      lookup(_hostname, _options, callback) {
        const selected = addresses[cursor++ % addresses.length];
        callback(null, selected.address, selected.family);
      },
    },
  });
  try {
    const response = await fetch(url, {
      dispatcher,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: { accept: '*/*', 'user-agent': 'Woody-File-Importer/1.0' },
    });
    return { response, dispatcher };
  } catch (error) {
    await dispatcher.close();
    throw error;
  }
}

export const secureLinkAdapter: CloudImportAdapter = {
  provider: 'secure_link',
  async download(input: CloudImportRequest): Promise<DownloadedCloudFile> {
    let current = new URL(input.url);
    let response;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const fetched = await fetchPinned(current);
      response = fetched.response;
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        try {
          if (!response.ok) {
            await response.body?.cancel();
            throw Object.assign(new Error(`CLOUD_IMPORT_DOWNLOAD_FAILED_${response.status}`), { statusCode: 422 });
          }
          const declaredLength = Number(response.headers.get('content-length') ?? 0);
          if (declaredLength > MAX_BYTES) {
            await response.body?.cancel();
            throw Object.assign(new Error('FILE_TOO_LARGE'), { statusCode: 413 });
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.length > MAX_BYTES) throw Object.assign(new Error('FILE_TOO_LARGE'), { statusCode: 413 });
          return {
            filename: filenameFrom(response, current, input.filename),
            mimetype: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
            buffer,
            provider: 'secure_link',
          };
        } finally {
          await fetched.dispatcher.close();
        }
      }
      const location = response.headers.get('location');
      await response.body?.cancel();
      await fetched.dispatcher.close();
      if (!location || redirects === 3) throw Object.assign(new Error('CLOUD_IMPORT_TOO_MANY_REDIRECTS'), { statusCode: 400 });
      current = new URL(location, current);
    }
    throw Object.assign(new Error('CLOUD_IMPORT_DOWNLOAD_FAILED'), { statusCode: 422 });
  },
};
