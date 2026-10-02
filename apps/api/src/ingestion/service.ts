import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CHUNKER_VERSION, chunkMarkdown } from './chunker.js';
import { type Embedder, validateVectors } from './embeddings.js';
import { DocumentStore, type WriteResult } from './store.js';

const inputSchema = z.object({
  sourceKey: z.string().trim().min(1).max(1024),
  sourceUrl: z
    .string()
    .url()
    .refine((value) =>
      ['https:', 'http:', 'file:'].includes(new URL(value).protocol),
    ),
  markdown: z
    .string()
    .min(1)
    .refine(
      (value) => Buffer.byteLength(value, 'utf8') <= 2 * 1024 * 1024,
      'Document exceeds 2 MiB',
    ),
});
export async function ingestMarkdown(
  input: z.infer<typeof inputSchema>,
  store: DocumentStore,
  embedder: Embedder,
): Promise<WriteResult> {
  const parsed = inputSchema.parse(input);
  const run = await store.startRun(parsed.sourceKey);
  try {
    const markdown = parsed.markdown.replace(/\r\n?/g, '\n');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          markdown,
          parsed.sourceUrl,
          embedder.model,
          CHUNKER_VERSION,
        ]),
      )
      .digest('hex');
    const prior = await store.find(parsed.sourceKey);
    if (prior?.fingerprint === fingerprint) {
      await store.finishRun(run, 'skipped');
      return {
        documentId: prior.id,
        version: prior.version,
        chunks: prior.chunks,
        status: 'skipped',
      };
    }
    const { title, chunks } = chunkMarkdown(markdown);
    if (chunks.length > 2000) throw new Error('Document exceeds chunk limit');
    const vectors = await embedder.embed(
      chunks.map((chunk) =>
        [...chunk.metadata.headings, chunk.content].join('\n'),
      ),
    );
    validateVectors(vectors, chunks.length);
    const result = await store.replace({
      ...parsed,
      title,
      fingerprint,
      model: embedder.model,
      chunks,
      vectors,
    });
    await store.finishRun(run, result.status);
    return result;
  } catch (error) {
    await store.finishRun(run, 'failed').catch(() => undefined);
    throw error;
  }
}
