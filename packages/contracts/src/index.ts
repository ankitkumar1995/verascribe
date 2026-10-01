import { z } from 'zod';
export const queryRequestSchema = z
  .object({ question: z.string().trim().min(1).max(2000) })
  .strict();
export const citationSchema = z.object({
  text: z.string(),
  sourceUrl: z.string(),
  chunkId: z.string().uuid(),
});
export const queryResponseSchema = z.object({
  answer: z.string(),
  citations: z.array(citationSchema),
  confidence: z.number().min(0).max(1),
  status: z.enum(['supported', 'partial', 'insufficient_evidence']),
});
export const healthSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('verascribe-api'),
});
export type QueryRequest = z.infer<typeof queryRequestSchema>;
export type QueryResponse = z.infer<typeof queryResponseSchema>;
