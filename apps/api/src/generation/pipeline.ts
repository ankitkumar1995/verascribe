import type { QueryEmbedder } from '../ingestion/embeddings.js';
import type { PairScorer } from '../reranking/local.js';
import { retrieveEvidence } from '../reranking/pipeline.js';
import type { RetrievalRequest, SearchBackend } from '../retrieval/types.js';
import { generateDraft } from './service.js';
import type { TextGenerator } from './types.js';

export async function answerDraft(
  request: RetrievalRequest,
  dependencies: {
    backend: SearchBackend;
    embedder: QueryEmbedder;
    reranker: PairScorer;
    generator: TextGenerator;
  },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const evidence = await retrieveEvidence(
    request,
    dependencies.backend,
    dependencies.embedder,
    dependencies.reranker,
    5,
  );
  signal?.throwIfAborted();
  return generateDraft(
    request.question,
    evidence.candidates,
    dependencies.generator,
    {},
    signal,
  );
}
