import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../src/ingestion/chunker.js';
describe('semantic Markdown chunking', () => {
  it('preserves hierarchy without treating code as headings', () => {
    const result = chunkMarkdown(
      '# Handbook\n\nIntro\n\n## Install\n\nUse npm.\n\n\x60\x60\x60sh\n# not a heading\n\x60\x60\x60',
    );
    expect(result.title).toBe('Handbook');
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[1]?.metadata.headings).toEqual([
      'Handbook',
      'Install',
    ]);
    expect(result.chunks[1]?.content).toContain('# not a heading');
  });
  it('bounds oversized paragraphs without losing text', () => {
    const input = 'a'.repeat(301);
    const { chunks } = chunkMarkdown(input, 100);
    expect(chunks.every((chunk) => chunk.content.length <= 100)).toBe(true);
    expect(chunks.map((chunk) => chunk.content).join('')).toBe(input);
  });
  it('handles setext headings and rejects empty documents', () => {
    expect(chunkMarkdown('Title\n=====\n\nBody').title).toBe('Title');
    expect(() => chunkMarkdown('  ')).toThrow();
    expect(() => chunkMarkdown('abc\0')).toThrow();
  });
});

it('preserves original line numbers with leading blank lines', () => {
  const { chunks } = chunkMarkdown('\n\n# Title\n\nText.');
  expect(chunks[0]?.metadata.startLine).toBe(3);
  expect(chunks[0]?.metadata.endLine).toBe(5);
});
