import { describe, it, expect, vi } from 'vitest';
import { extractPdf } from '../src/sources/pdf.js';
import {
  parseHtml,
  parsePdf,
  parseDownload,
  plainTextChunks,
} from '../src/sources/parse.js';
import {
  downloadUrl,
  validateUrl,
  isPublicAddress,
  resolvePublic,
  MAX_TEXT_BYTES,
  MAX_PDF_BYTES,
  type Transport,
} from '../src/sources/url.js';
import { makePdf } from './pdf-fixture.js';
describe('public HTTPS source policy', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.1.1',
    '192.168.2.2',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '198.18.0.1',
    '192.0.2.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2002:7f00:1::',
    '2001::1',
    '2001:20::1',
    '3fff::1',
    '64:ff9b::7f00:1',
  ])('blocks special address %s', (address) =>
    expect(isPublicAddress(address)).toBe(false),
  );
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'allows public address %s',
    (address) => expect(isPublicAddress(address)).toBe(true),
  );
  it.each([
    'http://example.com',
    'file:///etc/passwd',
    'https://user:pass@example.com',
    'https://example.com:8443',
    'https://localhost',
    'https://a.local',
    'https://127.1',
    'https://2130706433',
    'https://0x7f000001',
    'https://[::ffff:127.0.0.1]',
  ])('rejects unsafe URL %s', (url) =>
    expect(() => validateUrl(url)).toThrow(),
  );
  it('rejects DNS answers containing any non-public address', async () => {
    const resolve = vi.fn(async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(
      resolvePublic(
        validateUrl('https://example.com'),
        resolve as unknown as typeof import('node:dns/promises').lookup,
      ),
    ).rejects.toThrow();
  });
  it('revalidates redirects and uses the resolved IP on each hop', async () => {
    const transport = vi
      .fn<Transport>()
      .mockResolvedValueOnce({
        status: 302,
        location: 'https://second.example/page#x',
        contentType: '',
        body: Buffer.alloc(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        contentType: 'text/plain',
        body: Buffer.from('Public text'),
      });
    const resolve = vi.fn(async () => ({ address: '1.1.1.1', family: 4 }));
    const result = await downloadUrl('https://first.example', {
      transport,
      resolve,
    });
    expect(result.sourceUrl).toBe('https://second.example/page');
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]?.[1]).toEqual({
      address: '1.1.1.1',
      family: 4,
    });
  });
  it('blocks private redirect targets before contacting them', async () => {
    const transport = vi.fn<Transport>().mockResolvedValue({
      status: 302,
      location: 'https://169.254.169.254/latest',
      contentType: '',
      body: Buffer.alloc(0),
    });
    await expect(
      downloadUrl('https://example.com', {
        transport,
        resolve: async () => ({ address: '1.1.1.1', family: 4 }),
      }),
    ).rejects.toThrow();
    expect(transport).toHaveBeenCalledOnce();
  });
  it('bounds redirect loops and DNS wait time', async () => {
    const transport = vi.fn<Transport>().mockResolvedValue({
      status: 302,
      location: '/loop',
      contentType: '',
      body: Buffer.alloc(0),
    });
    await expect(
      downloadUrl('https://example.com', {
        transport,
        resolve: async () => ({ address: '1.1.1.1', family: 4 }),
      }),
    ).rejects.toThrow('Redirect limit');
    expect(transport).toHaveBeenCalledTimes(4);
    await expect(
      downloadUrl('https://example.com', {
        resolve: () => new Promise(() => {}),
        timeoutMs: 5,
      }),
    ).rejects.toThrow('timeout');
  });
});
describe('source parsing', () => {
  it('extracts HTML text without scripts/navigation or resource fetching', () => {
    const parsed = parseHtml(
      '<title>Guide &amp; Help</title><nav>Navigation</nav><main><h1>Reset</h1><p>Links expire in <strong>30 minutes</strong>.</p><script>secret()</script><img src="http://127.0.0.1/private"><p hidden>Hidden</p></main>',
    );
    expect(parsed.title).toBe('Guide & Help');
    expect(parseHtml('<title> </title><h1>Fallback title</h1>').title).toBe(
      'Fallback title',
    );
    expect(parsed.chunks.map((c) => c.content).join(' ')).toContain(
      '30 minutes',
    );
    expect(JSON.stringify(parsed)).not.toMatch(
      /secret|Navigation|Hidden|127.0/,
    );
    expect(parsed.chunks[0]?.metadata.lineBasis).toBe('extracted');
  });
  it('bounds text input and rejects empty/invalid encodings or types', async () => {
    expect(() => parseHtml('x'.repeat(MAX_TEXT_BYTES + 1))).toThrow();
    expect(() => parseHtml('<script>only scripts</script>')).toThrow();
    await expect(
      parseDownload({
        body: Buffer.from([255]),
        contentType: 'text/plain',
        sourceUrl: 'https://example.com',
      }),
    ).rejects.toThrow();
    await expect(
      parseDownload({
        body: Buffer.from('abc'),
        contentType: 'application/zip',
        sourceUrl: 'https://example.com',
      }),
    ).rejects.toThrow();
  });
  it('chunks literal text without losing page provenance or breaking unicode', () => {
    const text = '# Literal heading\n' + 'A 😀 sentence. '.repeat(300);
    const chunks = plainTextChunks(text, 'PDF', 2);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(1800);
      expect(chunk.metadata.page).toBe(2);
      expect(chunk.metadata.lineBasis).toBe('extracted');
      expect(chunk.content).not.toContain('�');
    }
    expect(chunks[0]?.content).toContain('# Literal heading');
  });
});
describe('isolated PDF extraction', () => {
  it('extracts real multipage PDF text and page-specific chunks', async () => {
    const parsed = await parsePdf(
      makePdf(['Reset links last 30 minutes.', 'Contact support for help.']),
    );
    expect(parsed.chunks).toHaveLength(2);
    expect(parsed.chunks[0]?.content).toContain('30 minutes');
    expect(parsed.chunks[1]?.metadata.page).toBe(2);
  }, 30000);
  it('rejects malformed, oversized, scanned, too-many-page and timed-out PDFs', async () => {
    await expect(extractPdf(Buffer.from('not a PDF'))).rejects.toThrow();
    const oversized = Buffer.alloc(MAX_PDF_BYTES + 1);
    oversized.write('%PDF-');
    await expect(extractPdf(oversized)).rejects.toThrow();
    await expect(extractPdf(Buffer.from('%PDF-broken'))).rejects.toThrow();
    await expect(extractPdf(makePdf(['']))).rejects.toThrow();
    await expect(
      extractPdf(makePdf(Array<string>(101).fill('Text'))),
    ).rejects.toThrow();
    await expect(extractPdf(makePdf(['Text']), 1)).rejects.toThrow();
  }, 30000);
});
