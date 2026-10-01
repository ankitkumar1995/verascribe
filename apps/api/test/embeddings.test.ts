import { describe, expect, it, vi } from 'vitest';
import { OllamaEmbedder } from '../src/ingestion/embeddings.js';
const vector = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
describe('Ollama boundary', () => {
  it('uses batches, a timeout, task prefixes, and disables silent truncation', async () => {
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        input: string[];
        truncate: boolean;
      };
      expect(body.truncate).toBe(false);
      expect(body.input[0]).toBe('search_document: text');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(
        JSON.stringify({ embeddings: body.input.map(() => vector) }),
      );
    });
    expect(
      await new OllamaEmbedder('nomic-embed-text', undefined, request).embed(
        Array(17).fill('text'),
      ),
    ).toHaveLength(17);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([
    { embeddings: [[1, 2]] },
    { embeddings: [] },
    { embeddings: [Array(768).fill(0)] },
    { embeddings: [Array(768).fill(null)] },
  ])('rejects invalid provider responses', async (body) => {
    const request = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(body)),
    );
    await expect(
      new OllamaEmbedder(undefined, undefined, request).embed(['text']),
    ).rejects.toThrow();
  });
  it('does not expose provider response text on HTTP errors', async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response('secret', { status: 500 }),
    );
    await expect(
      new OllamaEmbedder(undefined, undefined, request).embed(['text']),
    ).rejects.toThrow('Embedding provider request failed (500)');
  });
});

it('uses the query task prefix for Nomic searches', async () => {
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    expect(JSON.parse(String(init?.body)).input).toEqual([
      'search_query: question',
    ]);
    return new Response(JSON.stringify({ embeddings: [vector] }));
  });
  expect(
    await new OllamaEmbedder('nomic-embed-text', undefined, request).embedQuery(
      'question',
    ),
  ).toEqual(vector);
});

it('does not add Nomic-specific prefixes to other models', async () => {
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    expect(JSON.parse(String(init?.body)).input).toEqual(['question']);
    return new Response(JSON.stringify({ embeddings: [vector] }));
  });
  await new OllamaEmbedder('another-model', undefined, request).embedQuery(
    'question',
  );
});
