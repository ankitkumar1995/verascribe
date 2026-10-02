import { z } from 'zod';
import { queryRequestSchema } from '@verascribe/contracts';
import type { FusedChunk } from '../retrieval/types.js';
import { pairScoresSchema, type PairScorer } from './local.js';

export type RerankedChunk = FusedChunk & {
  rerankScore: number;
  retrievalRank: number;
  scoringTruncated: boolean;
};
export async function rerank(
  question: string,
  candidates: FusedChunk[],
  scorer: PairScorer,
  topK = 5,
): Promise<RerankedChunk[]> {
  const parsed = queryRequestSchema.parse({ question });
  z.number().int().min(1).max(100).parse(topK);
  if (candidates.length > 100)
    throw new Error('At most 100 candidates may be reranked');
  if (
    new Set(candidates.map((candidate) => candidate.chunkId)).size !==
    candidates.length
  )
    throw new Error('Duplicate reranking candidates');
  if (candidates.length === 0) return [];
  const scores = pairScoresSchema.parse(
    await scorer.score(
      parsed.question,
      candidates.map((candidate) => candidate.content),
    ),
  );
  if (scores.length !== candidates.length)
    throw new Error('Reranker score count mismatch');
  return candidates
    .map((candidate, index) => ({
      ...candidate,
      rerankScore: scores[index]!.score,
      retrievalRank: index + 1,
      scoringTruncated: scores[index]!.truncated,
    }))
    .sort(
      (a, b) =>
        b.rerankScore - a.rerankScore || a.retrievalRank - b.retrievalRank,
    )
    .slice(0, topK);
}
