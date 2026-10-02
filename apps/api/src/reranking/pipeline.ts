import { z } from 'zod';
import type { QueryEmbedder } from '../ingestion/embeddings.js';
import { retrieve } from '../retrieval/service.js';
import type { RetrievalRequest, SearchBackend } from '../retrieval/types.js';
import type { PairScorer } from './local.js';
import { rerank } from './service.js';

export async function retrieveEvidence(
  input: RetrievalRequest,
  backend: SearchBackend,
  embedder: QueryEmbedder,
  scorer: PairScorer,
  topK = 5,
) {
  z.number().int().min(1).max(100).parse(topK);
  const start = performance.now();
  const retrieved = await retrieve(input, backend, embedder);
  const retrievalMs = performance.now() - start;
  const rerankStart = performance.now();
  const candidates = await rerank(
    input.question,
    retrieved.candidates,
    scorer,
    topK,
  );
  return {
    model: retrieved.model,
    candidates,
    reranking: {
      enabled: true,
      model: scorer.model,
      revision: scorer.revision,
      topK,
      candidateCount: retrieved.candidates.length,
      retrievalMs,
      rerankMs: performance.now() - rerankStart,
    },
  };
}
