import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { MAX_PDF_BYTES, MAX_TEXT_BYTES } from './url.js';
const pagesSchema = z
  .array(
    z
      .object({
        page: z.number().int().positive().max(100),
        text: z.string().trim().min(1).max(500000),
      })
      .strict(),
  )
  .min(1)
  .max(100);
export type PdfPage = z.infer<typeof pagesSchema>[number];
export async function extractPdf(
  data: Buffer,
  timeoutMs = 30000,
): Promise<PdfPage[]> {
  if (
    data.length > MAX_PDF_BYTES ||
    !data.subarray(0, 5).equals(Buffer.from('%PDF-'))
  )
    throw new Error('Invalid PDF input');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--max-old-space-size=256',
        fileURLToPath(new URL('./pdf-worker.mjs', import.meta.url)),
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Do not pass provider credentials into the parser.
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      },
    );
    let bytes = 0;
    let failed = false;
    const chunks: Buffer[] = [];
    const fail = () => {
      failed = true;
      child.kill();
      reject(new Error('PDF extraction failed or exceeded limits'));
    };
    const timer = setTimeout(fail, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_TEXT_BYTES) fail();
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      fail();
    });
    child.stdin.on('error', () => {
      /* Exit handler reports early parser failure. */
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) {
        reject(
          new Error(
            'PDF extraction failed; encrypted, scanned, or oversized PDFs are not supported',
          ),
        );
        return;
      }
      try {
        const pages = pagesSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString('utf8')),
        );
        if (pages.some((page, index) => page.page !== index + 1))
          throw new Error('Invalid page sequence');
        resolve(pages);
      } catch {
        reject(new Error('Invalid PDF extraction output'));
      }
    });
    child.stdin.end(data);
  });
}
