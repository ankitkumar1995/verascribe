import { load } from 'cheerio';
import { chunkMarkdown, type TextChunk } from '../ingestion/chunker.js';
import { extractPdf } from './pdf.js';
import { MAX_TEXT_BYTES, type Download } from './url.js';
export type ParsedSource = { title: string; chunks: TextChunk[] };
export function plainTextChunks(
  text: string,
  title: string,
  page?: number,
): TextChunk[] {
  const source = text.replace(/\r\n?/g, '\n');
  if (!source.trim() || source.includes('\0'))
    throw new Error('No usable plain text');
  const chunks: TextChunk[] = [];
  let offset = 0;
  let line = 1;
  while (offset < source.length) {
    const rest = source.slice(offset);
    let end = Math.min(1800, rest.length);
    if (end < rest.length) {
      const boundary = rest.slice(0, end).search(/\s+\S*$/);
      if (boundary > 900) end = boundary;
      const code = rest.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end--;
    }
    const piece = rest.slice(0, end);
    const endLine = line + (piece.match(/\n/g)?.length ?? 0);
    if (piece.trim())
      chunks.push({
        content: piece.trim(),
        metadata: {
          headings: [title],
          startLine: line,
          endLine,
          ...(page ? { page } : {}),
          lineBasis: 'extracted',
        },
      });
    offset += end;
    line = endLine;
  }
  return chunks;
}

export function parseHtml(html: string): ParsedSource {
  if (Buffer.byteLength(html) > MAX_TEXT_BYTES)
    throw new Error('HTML exceeds size limit');
  const $ = load(html);
  $(
    'script,style,noscript,template,iframe,svg,nav,footer,form,[hidden],[aria-hidden="true"]',
  ).remove();
  const title = (
    $('title').first().text().trim() ||
    $('h1').first().text().trim() ||
    'Web document'
  )
    .trim()
    .slice(0, 500);
  const root = $('main').first().length
    ? $('main').first()
    : $('article').first().length
      ? $('article').first()
      : $('body');
  root.find('br').replaceWith('\n');
  root
    .find('p,div,section,article,h1,h2,h3,h4,h5,h6,li,tr,pre,blockquote')
    .append('\n\n');
  root.find('td,th').append(' | ');
  const text = root
    .text()
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
  if (!text) throw new Error('No usable HTML text');
  return { title, chunks: plainTextChunks(text, title) };
}
export async function parseDownload(download: Download): Promise<ParsedSource> {
  if (download.contentType === 'application/pdf')
    return parsePdf(download.body);
  if (download.body.length > MAX_TEXT_BYTES)
    throw new Error('Text exceeds size limit');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(download.body);
  if (download.contentType === 'text/html') return parseHtml(text);
  if (download.contentType === 'text/markdown') return chunkMarkdown(text);
  if (download.contentType === 'text/plain')
    return {
      title: 'Text document',
      chunks: plainTextChunks(text, 'Text document'),
    };
  throw new Error('Unsupported source type');
}
export async function parsePdf(data: Buffer): Promise<ParsedSource> {
  const pages = await extractPdf(data);
  const title = 'PDF document';
  return {
    title,
    chunks: pages.flatMap((page) =>
      plainTextChunks(page.text, title, page.page),
    ),
  };
}
