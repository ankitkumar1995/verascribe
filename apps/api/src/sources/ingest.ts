import { createHash } from 'node:crypto';
import { z } from 'zod';
import { chunkMetadataSchema } from '@verascribe/contracts';
import { type Embedder, validateVectors } from '../ingestion/embeddings.js';
import { type DocumentStore, type WriteResult } from '../ingestion/store.js';
import type { ParsedSource } from './parse.js';
const inputSchema = z.object({
  sourceKey: z.string().trim().min(1).max(1024),
  sourceUrl: z
    .string()
    .url()
    .refine((value) =>
      ['https:', 'http:', 'file:'].includes(new URL(value).protocol),
    ),
  title: z.string().min(1).max(500),
  chunks: z
    .array(
      z.object({
        content: z
          .string()
          .min(1)
          .max(1800)
          .refine((value) => !value.includes('\0')),
        metadata: chunkMetadataSchema,
      }),
    )
    .min(1)
    .max(2000),
});
export async function ingestParsed(
  input: ParsedSource & { sourceKey: string; sourceUrl: string },
  store: DocumentStore,
  embedder: Embedder,
): Promise<WriteResult> {
  const parsed = inputSchema.parse(input);
  const run = await store.startRun(parsed.sourceKey);
  try {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          parsed.sourceUrl,
          parsed.title,
          parsed.chunks,
          embedder.model,
          'additional-sources-v1',
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
    const vectors = await embedder.embed(
      parsed.chunks.map((chunk) =>
        [...chunk.metadata.headings, chunk.content].join('\n'),
      ),
    );
    validateVectors(vectors, parsed.chunks.length);
    const result = await store.replace({
      ...parsed,
      fingerprint,
      model: embedder.model,
      vectors,
    });
    await store.finishRun(run, result.status);
    return result;
  } catch (error) {
    await store.finishRun(run, 'failed').catch(() => undefined);
    throw error;
  }
}
