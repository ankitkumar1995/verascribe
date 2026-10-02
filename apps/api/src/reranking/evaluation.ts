import {
  scoreRetrieval,
  summarizeEvaluation,
  type EvaluationCase,
} from '../retrieval/evaluation.js';
import type { FusedChunk } from '../retrieval/types.js';
import { rerank } from './service.js';
import type { PairScorer } from './local.js';

export async function compareReranking(
  testCase: EvaluationCase,
  candidates: FusedChunk[],
  scorer: PairScorer,
  topK = 5,
) {
  const baseline = scoreRetrieval(testCase, candidates, topK);
  const start = performance.now();
  const reordered = await rerank(testCase.question, candidates, scorer, topK);
  return {
    baseline,
    reranked: scoreRetrieval(testCase, reordered, topK),
    rerankMs: performance.now() - start,
    truncatedSelectedCandidates: reordered.filter(
      (candidate) => candidate.scoringTruncated,
    ).length,
  };
}
export function summarizeComparison(
  rows: Awaited<ReturnType<typeof compareReranking>>[],
) {
  const baseline = summarizeEvaluation(rows.map((row) => row.baseline));
  const reranked = summarizeEvaluation(rows.map((row) => row.reranked));
  const durations = rows.map((row) => row.rerankMs).sort((a, b) => a - b);
  return {
    baseline,
    reranked,
    recallDelta:
      baseline.meanRecallAtK === null || reranked.meanRecallAtK === null
        ? null
        : reranked.meanRecallAtK - baseline.meanRecallAtK,
    mrrDelta:
      baseline.meanReciprocalRankAtK === null ||
      reranked.meanReciprocalRankAtK === null
        ? null
        : reranked.meanReciprocalRankAtK - baseline.meanReciprocalRankAtK,
    meanRerankMs: durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null,
    p95RerankMs: durations.length
      ? durations[Math.ceil(durations.length * 0.95) - 1]!
      : null,
  };
}
