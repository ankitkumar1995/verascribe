import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export type Address = { address: string; family: number };
export function isPublicAddress(address: string): boolean {
  try {
    const ip = ipaddr.parse(address);
    if (ip.range() !== 'unicast') return false;
    // Restrict IPv6 to global unicast; this excludes translation/tunnel/local ranges.
    if (ip.kind() === 'ipv4') return true;
    const v6 = ip as ipaddr.IPv6;
    return (
      v6.match(ipaddr.IPv6.parse('2000::'), 3) &&
      !v6.match(ipaddr.IPv6.parse('2001::'), 23) &&
      !v6.match(ipaddr.IPv6.parse('3fff::'), 20)
    );
  } catch {
    return false;
  }
}
export function validateUrl(value: string): URL {
  if (value.length > 2048) throw new Error('URL is too long');
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password
  )
    throw new Error(
      'Only credential-free HTTPS URLs on port 443 are supported',
    );
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    !host ||
    host.endsWith('.') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  )
    throw new Error('Local hostnames are not supported');
  if (ipaddr.isValid(host) && !isPublicAddress(host))
    throw new Error('Non-public address');
  url.hash = '';
  return url;
}
export async function resolvePublic(
  url: URL,
  resolve = lookup,
): Promise<Address> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = ipaddr.isValid(host)
    ? [{ address: host, family: ipaddr.parse(host).kind() === 'ipv4' ? 4 : 6 }]
    : await resolve(host, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some((item) => !isPublicAddress(item.address))
  )
    throw new Error('DNS must resolve exclusively to public addresses');
  return addresses[0]!;
}
export type Download = { body: Buffer; contentType: string; sourceUrl: string };
type Hop = {
  status: number;
  location?: string;
  contentType: string;
  body: Buffer;
};
export type Transport = (
  url: URL,
  address: Address,
  signal: AbortSignal,
) => Promise<Hop>;
export const requestPinned: Transport = (url, address, signal) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        agent: false,
        signal,
        family: address.family,

        lookup: (_host, _options, callback) =>
          callback(null, address.address, address.family),
        headers: {
          Accept: 'text/html,text/plain,text/markdown,application/pdf',
          'Accept-Encoding': 'identity',
          'User-Agent': 'VeraScribe/0.1',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = res.headers.location;
          res.destroy();
          resolve({
            status,
            ...(location ? { location } : {}),
            contentType: '',
            body: Buffer.alloc(0),
          });
          return;
        }
        const contentType = (res.headers['content-type'] ?? '')
          .split(';')[0]!
          .trim()
          .toLowerCase();
        const cap =
          contentType === 'application/pdf' ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
        const encoding = res.headers['content-encoding'];
        if (
          status !== 200 ||
          ![
            'text/html',
            'text/plain',
            'text/markdown',
            'application/pdf',
          ].includes(contentType) ||
          (encoding && encoding !== 'identity') ||
          Number(res.headers['content-length'] ?? 0) > cap
        ) {
          res.destroy();
          reject(new Error('Unsupported or oversized response'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > cap) {
            res.destroy(new Error('Response exceeds byte limit'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('Response aborted')));
        res.on('end', () =>
          resolve({ status, contentType, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
export async function downloadUrl(
  value: string,
  options: {
    resolve?: (url: URL) => Promise<Address>;
    transport?: Transport;
    timeoutMs?: number;
  } = {},
): Promise<Download> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Download timeout')),
    options.timeoutMs ?? 20000,
  );
  let abort!: () => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Download timeout'));
    controller.signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([
      (async () => {
        let url = validateUrl(value);
        for (let redirects = 0; redirects <= 3; redirects++) {
          controller.signal.throwIfAborted();
          const address = await (options.resolve ?? resolvePublic)(url);
          controller.signal.throwIfAborted();
          if (!isPublicAddress(address.address))
            throw new Error('Non-public address');
          const response = await (options.transport ?? requestPinned)(
            url,
            address,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (!response.location || redirects === 3)
              throw new Error('Redirect limit');
            url = validateUrl(new URL(response.location, url).href);
            continue;
          }
          if (response.status !== 200) throw new Error('Download failed');
          return {
            body: response.body,
            contentType: response.contentType,
            sourceUrl: url.href,
          };
        }
        throw new Error('Redirect limit');
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener('abort', abort);
  }
}
