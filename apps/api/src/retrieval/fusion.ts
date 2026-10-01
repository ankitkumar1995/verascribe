import type { FusedChunk, RankedChunk } from './types.js';

// Ranks are one-based. Raw cosine and text scores are intentionally not combined.
export function reciprocalRankFusion(
  dense: RankedChunk[],
  sparse: RankedChunk[],
  limit = 30,
  k = 60,
): FusedChunk[] {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isFinite(k) ||
    k <= 0
  ) {
    throw new Error('Invalid fusion configuration');
  }
  const combined = new Map<string, FusedChunk>();
  for (const [leg, hits] of [
    ['dense', dense],
    ['sparse', sparse],
  ] as const) {
    const seen = new Set<string>();
    let rank = 0;
    for (const { score, ...chunk } of hits) {
      if (seen.has(chunk.chunkId)) continue;
      seen.add(chunk.chunkId);
      rank++;
      const result = combined.get(chunk.chunkId) ?? {
        ...chunk,
        rrfScore: 0,
        denseRank: null,
        sparseRank: null,
        cosineSimilarity: null,
        textScore: null,
      };
      result.rrfScore += 1 / (k + rank);
      if (leg === 'dense') {
        result.denseRank = rank;
        result.cosineSimilarity = score;
      } else {
        result.sparseRank = rank;
        result.textScore = score;
      }
      combined.set(chunk.chunkId, result);
    }
  }
  return [...combined.values()]
    .sort(
      (a, b) =>
        b.rrfScore - a.rrfScore ||
        (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0),
    )
    .slice(0, limit);
}
