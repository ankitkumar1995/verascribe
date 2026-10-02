import type { QueryEmbedder } from '../ingestion/embeddings.js';
import { validateVectors } from '../ingestion/embeddings.js';
import { reciprocalRankFusion } from './fusion.js';
import {
  retrievalRequestSchema,
  type RetrievalRequest,
  type SearchBackend,
} from './types.js';

export async function retrieve(
  input: RetrievalRequest,
  backend: SearchBackend,
  embedder: QueryEmbedder,
) {
  const options = retrievalRequestSchema.parse(input);
  if (options.sourceKeys?.length === 0)
    return { model: embedder.model, candidates: [] };
  const vector = await embedder.embedQuery(options.question);
  validateVectors([vector], 1);
  const { dense, sparse } = await backend.search(
    vector,
    embedder.model,
    options,
  );
  return {
    model: embedder.model,
    candidates: reciprocalRankFusion(dense, sparse, options.limit),
  };
}
