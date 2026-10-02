import process from 'node:process';
import { Buffer } from 'node:buffer';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
// Separate process: bounded input/output, parent-enforced wall deadline and V8 heap cap.
try {
  const parts = [];
  let bytes = 0;
  for await (const part of process.stdin) {
    bytes += part.length;
    if (bytes > 10 * 1024 * 1024) throw new Error('PDF too large');
    parts.push(part);
  }
  const data = new Uint8Array(Buffer.concat(parts));
  const task = getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    if (doc.numPages > 100) throw new Error('Too many pages');
    const pages = [];
    let chars = 0;
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      const text = content.items
        .filter((item) => 'str' in item)
        .map((item) => item.str + (item.hasEOL ? '\n' : ' '))
        .join('')
        .trim();
      chars += text.length;
      if (chars > 500000) throw new Error('Extracted text exceeds limit');
      pages.push({ page: number, text });
      page.cleanup();
    }
    if (pages.some((page) => !page.text.trim()))
      throw new Error('Empty or image-only page requires OCR');
    process.stdout.write(JSON.stringify(pages));
  } finally {
    await task.destroy();
  }
} catch {
  process.stderr.write('PDF extraction failed.');
  process.exitCode = 1;
}
