import { z } from 'zod';
import { chunkMetadataSchema } from '@verascribe/contracts';

export const retrievalRequestSchema = z
  .object({
    question: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .refine(
        (value) => !value.includes('\0'),
        'Question contains a null byte',
      ),
    limit: z.number().int().min(1).max(100).default(30),
    candidateLimit: z.number().int().min(1).max(100).default(30),
    sourceKeys: z.array(z.string().min(1).max(1024)).max(100).optional(),
  })
  .strict()
  .refine(
    (value) => value.limit <= value.candidateLimit,
    'limit must not exceed candidateLimit',
  );

export const sourceChunkSchema = z.object({
  chunkId: z.string().uuid(),
  documentId: z.string().uuid(),
  sourceKey: z.string(),
  sourceUrl: z.string(),
  title: z.string(),
  version: z.number().int().positive(),
  ordinal: z.number().int().nonnegative(),
  content: z.string(),
  metadata: chunkMetadataSchema,
});
export const rankedChunkSchema = sourceChunkSchema.extend({
  score: z.number().finite(),
});
export type SourceChunk = z.infer<typeof sourceChunkSchema>;
export type RankedChunk = z.infer<typeof rankedChunkSchema>;
export type RetrievalRequest = z.input<typeof retrievalRequestSchema>;
export type SearchOptions = z.output<typeof retrievalRequestSchema>;
export type FusedChunk = SourceChunk & {
  rrfScore: number;
  denseRank: number | null;
  sparseRank: number | null;
  cosineSimilarity: number | null;
  textScore: number | null;
};
export interface SearchBackend {
  search(
    vector: number[],
    model: string,
    options: SearchOptions,
  ): Promise<{ dense: RankedChunk[]; sparse: RankedChunk[] }>;
}
