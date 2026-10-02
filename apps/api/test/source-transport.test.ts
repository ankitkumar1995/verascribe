import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ClientRequest } from 'node:http';
import { request, type RequestOptions } from 'node:https';
import { describe, it, expect, vi } from 'vitest';
import { requestPinned, MAX_TEXT_BYTES } from '../src/sources/url.js';
vi.mock('node:https', () => ({ request: vi.fn() }));
function respond(
  status: number,
  headers: Record<string, string>,
  chunks: Buffer[],
) {
  let options: RequestOptions | undefined;
  vi.mocked(request).mockImplementation(((
    _url: URL,
    settings: RequestOptions,
    callback: (res: IncomingMessage) => void,
  ) => {
    options = settings;
    const outgoing = new EventEmitter() as ClientRequest;
    outgoing.end = (() => {
      const incoming = Object.assign(new PassThrough(), {
        statusCode: status,
        headers,
      });
      callback(incoming as unknown as IncomingMessage);
      for (const chunk of chunks) incoming.write(chunk);
      incoming.end();
      return outgoing;
    }) as ClientRequest['end'];
    return outgoing;
  }) as typeof request);
  return () => options;
}
describe('pinned HTTPS transport', () => {
  it('pins lookup without disabling TLS validation or using a shared agent', async () => {
    const getOptions = respond(200, { 'content-type': 'text/plain' }, [
      Buffer.from('Hello'),
    ]);
    const result = await requestPinned(
      new URL('https://example.com'),
      { address: '1.1.1.1', family: 4 },
      new AbortController().signal,
    );
    expect(result.body.toString()).toBe('Hello');
    const options = getOptions()!;
    expect(options.agent).toBe(false);
    expect(options.rejectUnauthorized).not.toBe(false);
    expect(options.family).toBe(4);
    const callback = vi.fn();
    options.lookup!('example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '1.1.1.1', 4);
  });
  it.each([
    [200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }],
    [200, { 'content-type': 'application/zip' }],
    [500, { 'content-type': 'text/plain' }],
    [
      200,
      {
        'content-type': 'text/plain',
        'content-length': String(MAX_TEXT_BYTES + 1),
      },
    ],
  ])('rejects unsupported responses %#', async (status, headers) => {
    respond(status, headers, []);
    await expect(
      requestPinned(
        new URL('https://example.com'),
        { address: '1.1.1.1', family: 4 },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
  it('bounds streamed bytes even without content-length', async () => {
    respond(200, { 'content-type': 'text/plain' }, [
      Buffer.alloc(MAX_TEXT_BYTES),
      Buffer.from('x'),
    ]);
    await expect(
      requestPinned(
        new URL('https://example.com'),
        { address: '1.1.1.1', family: 4 },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
});
