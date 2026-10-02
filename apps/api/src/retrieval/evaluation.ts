import { z } from 'zod';
import type { FusedChunk } from './types.js';

const documentSchema = z.object({
  key: z.string().min(1),
  markdown: z.string().min(1),
});
const caseSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1).max(2000),
    category: z.enum(['answerable', 'ambiguous', 'unanswerable']),
    relevantSources: z
      .array(z.string())
      .refine(
        (keys) => new Set(keys).size === keys.length,
        'Duplicate relevance labels',
      ),
  })
  .superRefine((item, ctx) => {
    if (
      (item.category === 'unanswerable') !==
      (item.relevantSources.length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Only unanswerable cases have no relevant sources',
      });
    }
  });
export const evaluationDatasetSchema = z
  .object({
    documents: z.array(documentSchema).min(1),
    cases: z.array(caseSchema).min(1),
  })
  .superRefine((data, ctx) => {
    const keys = new Set(data.documents.map((item) => item.key));
    if (
      keys.size !== data.documents.length ||
      new Set(data.cases.map((item) => item.id)).size !== data.cases.length
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate document or case IDs',
      });
    }
    if (
      data.cases.some((item) =>
        item.relevantSources.some((key) => !keys.has(key)),
      )
    ) {
      ctx.addIssue({ code: 'custom', message: 'Unknown relevant source' });
    }
  });
export type EvaluationCase = z.infer<typeof caseSchema>;

export function scoreRetrieval(
  testCase: EvaluationCase,
  candidates: Pick<FusedChunk, 'sourceKey'>[],
  k = 5,
) {
  if (!Number.isInteger(k) || k < 1)
    throw new Error('Invalid evaluation cutoff');
  const top = candidates.slice(0, k);
  const retrieved = new Set(top.map((hit) => hit.sourceKey));
  const relevant = new Set(testCase.relevantSources);
  const hits = [...relevant].filter((source) => retrieved.has(source)).length;
  const first = top.findIndex((hit) => relevant.has(hit.sourceKey));
  return {
    id: testCase.id,
    category: testCase.category,
    candidateCount: top.length,
    // Unanswerable cases have no relevance denominator. Candidates are not answers.
    recallAtK: relevant.size ? hits / relevant.size : null,
    reciprocalRankAtK: relevant.size ? (first < 0 ? 0 : 1 / (first + 1)) : null,
  };
}
export function summarizeEvaluation(rows: ReturnType<typeof scoreRetrieval>[]) {
  const scored = rows.filter((row) => row.recallAtK !== null);
  return {
    cases: rows.length,
    scoredCases: scored.length,
    meanRecallAtK: scored.length
      ? scored.reduce((sum, row) => sum + row.recallAtK!, 0) / scored.length
      : null,
    meanReciprocalRankAtK: scored.length
      ? scored.reduce((sum, row) => sum + row.reciprocalRankAtK!, 0) /
        scored.length
      : null,
    unanswerableCases: rows.filter((row) => row.category === 'unanswerable')
      .length,
  };
}
