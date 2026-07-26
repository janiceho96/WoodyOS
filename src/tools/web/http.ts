import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isPublicIp } from '../../lib/network.js';
import { combinedAbortSignal } from '../../runtime/cancellation.js';

export type SafeHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  url: string;
};

export type SafeHttpOptions = {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowCrossOriginRedirects?: boolean;
  signal?: AbortSignal;
};

export function validatedPublicHttpsUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw Object.assign(new Error('URL must be a valid HTTPS address'), { statusCode: 400 }); }
  if (url.protocol !== 'https:') throw Object.assign(new Error('Only HTTPS addresses are allowed'), { statusCode: 400 });
  if (url.username || url.password) throw Object.assign(new Error('Credentials are not allowed inside URLs'), { statusCode: 400 });
  if (!url.hostname || url.hostname.length > 253) throw Object.assign(new Error('URL hostname is invalid'), { statusCode: 400 });
  return url;
}

async function pinnedAddress(url: URL) {
  if (isIP(url.hostname)) {
    if (!isPublicIp(url.hostname)) throw Object.assign(new Error('Private, local, and reserved addresses are blocked'), { statusCode: 400 });
    return { address: url.hostname, family: isIP(url.hostname) as 4 | 6 };
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
    throw Object.assign(new Error('The hostname resolves to a private, local, or reserved address'), { statusCode: 400 });
  }
  return addresses[0] as { address: string; family: 4 | 6 };
}

export function createPinnedLookup(pinned: { address: string; family: 4 | 6 }): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

export async function assertPublicHttpsUrl(raw: string) {
  const url = validatedPublicHttpsUrl(raw);
  await pinnedAddress(url);
  return url;
}

function headerMap(headers: Record<string, string | string[] | undefined>) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : value ?? '']));
}

async function oneRequest(url: URL, options: Required<Pick<SafeHttpOptions, 'method' | 'timeoutMs' | 'maxBytes'>> & SafeHttpOptions) {
  options.signal?.throwIfAborted();
  const pinned = await pinnedAddress(url);
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<SafeHttpResponse>((resolve, reject) => {
    let settled = false;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = transport(url, {
      method: options.method,
      headers: {
        accept: 'application/json, text/html;q=0.9, text/plain;q=0.8',
        'user-agent': 'Woody-Agent-OS/0.1 (+local-user-controlled-web-research)',
        ...options.headers,
        host: url.host,
      },
      lookup: createPinnedLookup(pinned),
      servername: url.hostname,
      timeout: options.timeoutMs,
      signal: combinedAbortSignal(options.signal, options.timeoutMs),
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > options.maxBytes) {
          response.destroy();
          finishError(Object.assign(new Error(`Response exceeded the ${options.maxBytes.toLocaleString()} byte safety limit`), { statusCode: 413 }));
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status: response.statusCode ?? 0, headers: headerMap(response.headers), body: Buffer.concat(chunks), url: url.toString() });
      });
      response.on('error', finishError);
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('External request timed out'), { statusCode: 504 })));
    request.on('error', finishError);
    if (options.body) request.write(options.body);
    request.end();
  });
}

export async function safeHttpRequest(rawUrl: string, options: SafeHttpOptions = {}): Promise<SafeHttpResponse> {
  let url = validatedPublicHttpsUrl(rawUrl);
  let method = options.method ?? 'GET';
  let body = options.body;
  const headers = { ...(options.headers ?? {}) };
  const maxRedirects = Math.min(3, Math.max(0, options.maxRedirects ?? 0));
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    options.signal?.throwIfAborted();
    const response = await oneRequest(url, {
      ...options,
      method,
      body,
      headers,
      timeoutMs: Math.min(30_000, Math.max(1_000, options.timeoutMs ?? 15_000)),
      maxBytes: Math.min(5_000_000, Math.max(1_000, options.maxBytes ?? 1_000_000)),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.location;
    if (!location || redirect === maxRedirects) throw Object.assign(new Error('External redirect was blocked'), { statusCode: 502 });
    const next = validatedPublicHttpsUrl(new URL(location, url).toString());
    if (next.origin !== url.origin && !options.allowCrossOriginRedirects) {
      throw Object.assign(new Error('Cross-origin redirects are blocked'), { statusCode: 502 });
    }
    if (next.origin !== url.origin && Object.keys(headers).some((key) => /authorization|api[-_]?key|token/i.test(key))) {
      throw Object.assign(new Error('Credential-bearing cross-origin redirects are blocked'), { statusCode: 502 });
    }
    if (response.status === 303) { method = 'GET'; body = undefined; }
    url = next;
  }
  throw Object.assign(new Error('Too many external redirects'), { statusCode: 502 });
}

export function jsonBody<T>(response: SafeHttpResponse): T {
  const text = response.body.toString('utf8');
  if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`External service returned ${response.status}: ${text.slice(0, 500)}`), { statusCode: 502 });
  try { return JSON.parse(text) as T; }
  catch { throw Object.assign(new Error('External service returned invalid JSON'), { statusCode: 502 }); }
}
