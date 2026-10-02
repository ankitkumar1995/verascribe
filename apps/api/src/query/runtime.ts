import { Pool } from 'pg';
import { z } from 'zod';
import { OllamaEmbedder } from '../ingestion/embeddings.js';
import { PostgresSearch } from '../retrieval/postgres.js';
import { createReranker, readRerankConfig } from '../reranking/config.js';
import { GroqGenerator } from '../generation/groq.js';
import { answerVerified } from '../guardrails/pipeline.js';
import { createVerifierFromEnv } from '../guardrails/config.js';
import { createQueryService } from './service.js';
export function createQueryRuntime(
  env: NodeJS.ProcessEnv = process.env,
  cacheDir?: string,
) {
  const enabled = z
    .enum(['true', 'false'])
    .default('false')
    .parse(env.QUERY_ENABLED);
  if (enabled === 'false') return undefined;
  const config = z
    .object({
      DATABASE_URL: z.string().url(),
      OLLAMA_URL: z.string().url().default('http://127.0.0.1:11434'),
      EMBEDDING_MODEL: z.string().min(1).default('nomic-embed-text'),
      GROQ_API_KEY: z.string().trim().min(1),
      GROQ_MODEL: z.string().trim().min(1).default('llama-3.3-70b-versatile'),
      GENERATION_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(1)
        .max(120000)
        .default(30000),
      QUERY_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(1000)
        .max(300000)
        .default(120000),
    })
    .parse(env);
  const reranker = createReranker(
    readRerankConfig({
      ...env,
      RERANK_CACHE_DIR: env.RERANK_CACHE_DIR ?? cacheDir,
    }),
  );
  const { verifier, policy } = createVerifierFromEnv({
    ...env,
    NLI_CACHE_DIR: env.NLI_CACHE_DIR ?? cacheDir,
  });
  const generator = new GroqGenerator({
    apiKey: config.GROQ_API_KEY,
    model: config.GROQ_MODEL,
    timeoutMs: config.GENERATION_TIMEOUT_MS,
  });
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 5000,
  });
  const dependencies = {
    backend: new PostgresSearch(pool),
    embedder: new OllamaEmbedder(config.EMBEDDING_MODEL, config.OLLAMA_URL),
    reranker,
    generator,
    verifier,
  };
  return createQueryService(
    (request, signal) => answerVerified(request, dependencies, policy, signal),
    async () => {
      try {
        await verifier.dispose();
      } finally {
        try {
          await reranker.dispose();
        } finally {
          await pool.end();
        }
      }
    },
    config.QUERY_TIMEOUT_MS,
  );
}
