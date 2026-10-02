import { z } from 'zod';

export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}
export function validateVectors(vectors: number[][], expected: number): void {
  if (
    vectors.length !== expected ||
    vectors.some(
      (vector) =>
        vector.length !== 768 ||
        vector.some((value) => !Number.isFinite(value)) ||
        !vector.some((value) => value !== 0),
    )
  )
    throw new Error('Invalid embedding dimensions, count, or values');
}
export class OllamaEmbedder implements Embedder {
  constructor(
    readonly model = 'nomic-embed-text',
    private readonly baseUrl = 'http://127.0.0.1:11434',
    private readonly request: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}
  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += 16) {
      const batch = texts.slice(offset, offset + 16);
      const input = batch.map((text) =>
        this.model.startsWith('nomic-embed-text')
          ? 'search_document: ' + text
          : text,
      );
      const response = await this.request(new URL('/api/embed', this.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input, truncate: false }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok)
        throw new Error(
          'Embedding provider request failed (' + response.status + ')',
        );
      const data = z
        .object({ embeddings: z.array(z.array(z.number())) })
        .parse(await response.json());
      validateVectors(data.embeddings, batch.length);
      vectors.push(...data.embeddings);
    }
    return vectors;
  }
}
