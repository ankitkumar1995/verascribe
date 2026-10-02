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

export const FALLBACK_ANSWER =
  "I don't have enough information to answer that.";
export const chunkMetadataSchema = z.object({
  headings: z.array(z.string()),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  page: z.number().int().positive().optional(),
  lineBasis: z.enum(['source', 'extracted']).optional(),
});
export type ChunkMetadata = z.infer<typeof chunkMetadataSchema>;

export const draftCitationSchema = citationSchema.extend({
  id: z.number().int().positive(),
  documentId: z.string().uuid(),
  title: z.string(),
  version: z.number().int().positive(),
  metadata: chunkMetadataSchema,
});
export const draftAnswerSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('draft'),
      verification: z.literal('pending'),
      answer: z.string().min(1),
      claims: z
        .array(
          z.object({
            text: z.string().min(1),
            citationIds: z.array(z.number().int().positive()).min(1),
          }),
        )
        .min(1),
      citations: z.array(draftCitationSchema).min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('insufficient_evidence'),
      verification: z.literal('not_applicable'),
      answer: z.literal(FALLBACK_ANSWER),
      claims: z.tuple([]),
      citations: z.tuple([]),
    })
    .strict(),
]);
export type DraftAnswer = z.infer<typeof draftAnswerSchema>;

export const verifiedAnswerSchema = queryResponseSchema
  .extend({
    citations: z.array(draftCitationSchema),
    claims: z.array(
      z.object({
        text: z.string().min(1),
        citationIds: z.array(z.number().int().positive()).min(1),
      }),
    ),
    verification: z.object({
      model: z.string(),
      revision: z.string(),
      entailmentThreshold: z.number().min(0.5).max(1),
      minimumSupportRatio: z.number().min(0.5).max(1),
      assessedClaims: z.number().int().nonnegative(),
      supportedClaims: z.number().int().nonnegative(),
      returnedClaims: z.number().int().nonnegative(),
      assessments: z.array(
        z.object({
          claimIndex: z.number().int().nonnegative(),
          outcome: z.enum([
            'entailed',
            'contradicted',
            'not_entailed',
            'input_too_long',
          ]),
        }),
      ),
    }),
    note: z.string().nullable(),
  })
  .strict();
export type VerifiedAnswer = z.infer<typeof verifiedAnswerSchema>;
