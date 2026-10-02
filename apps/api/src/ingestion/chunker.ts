import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { toString } from 'mdast-util-to-string';

export const CHUNKER_VERSION = 'markdown-v1-1800';
export type TextChunk = {
  content: string;
  metadata: { headings: string[]; startLine: number; endLine: number };
};

export function chunkMarkdown(
  markdown: string,
  maxChars = 1800,
): { title: string; chunks: TextChunk[] } {
  if (!Number.isInteger(maxChars) || maxChars < 100)
    throw new Error('Invalid chunk size');
  const source = markdown.replace(/\r\n?/g, '\n');
  if (!source.trim() || source.includes('\0'))
    throw new Error('Document must contain text without null bytes');
  const tree = unified().use(remarkParse).parse(source);
  const title = tree.children.find(
    (node) => node.type === 'heading' && node.depth === 1,
  );
  const headings: string[] = [];
  const chunks: TextChunk[] = [];
  let pending: TextChunk | undefined;
  const flush = () => {
    if (pending) chunks.push(pending);
    pending = undefined;
  };
  for (const node of tree.children) {
    if (!node.position) continue;
    if (node.type === 'heading') {
      flush();
      headings.length = node.depth - 1;
      headings[node.depth - 1] = toString(node);
    }
    const raw = source.slice(
      node.position.start.offset,
      node.position.end.offset,
    );
    let offset = 0;
    let line = node.position.start.line;
    while (offset < raw.length) {
      const remaining = raw.slice(offset);
      let end = Math.min(maxChars, remaining.length);
      if (end < remaining.length) {
        const boundary = remaining.slice(0, end).search(/\s+\S*$/);
        if (boundary > maxChars / 2) end = boundary;
        // Never cut a UTF-16 surrogate pair in half.
        const code = remaining.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end--;
      }
      const piece = remaining.slice(0, end);
      const content = piece.trim();
      const endLine = line + (piece.match(/\n/g)?.length ?? 0);
      if (content) {
        if (
          pending &&
          pending.content.length + 2 + content.length <= maxChars
        ) {
          pending.content += '\n\n' + content;
          pending.metadata.endLine = endLine;
        } else {
          flush();
          pending = {
            content,
            metadata: {
              headings: headings.filter(Boolean),
              startLine: line,
              endLine,
            },
          };
        }
      }
      offset += end;
      line = endLine;
    }
  }
  flush();
  if (chunks.length === 0) throw new Error('No ingestible text');
  return { title: title ? toString(title) : 'Untitled document', chunks };
}
