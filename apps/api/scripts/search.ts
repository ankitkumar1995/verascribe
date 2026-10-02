import 'dotenv/config';
import { Pool } from 'pg';
import { z } from 'zod';
import { OllamaEmbedder } from '../src/ingestion/embeddings.js';
import { PostgresSearch } from '../src/retrieval/postgres.js';
import { retrieve } from '../src/retrieval/service.js';
import { retrieveEvidence } from '../src/reranking/pipeline.js';
import { createReranker, readRerankConfig } from '../src/reranking/config.js';

async function main() {
  const [question, ...sourceKeys] = process.argv.slice(2);
  if (!question)
    throw new Error('Usage: npm run search -- "question" [source-key ...]');
  const config = z
    .object({
      DATABASE_URL: z.string().url(),
      OLLAMA_URL: z.string().url().default('http://127.0.0.1:11434'),
      EMBEDDING_MODEL: z.string().min(1).default('nomic-embed-text'),
    })
    .parse(process.env);
  const rerankConfig = readRerankConfig();
  const reranker = rerankConfig.RERANK_ENABLED
    ? createReranker(rerankConfig)
    : undefined;
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 5000,
  });
  try {
    const input = { question, ...(sourceKeys.length ? { sourceKeys } : {}) };
    const backend = new PostgresSearch(pool);
    const embedder = new OllamaEmbedder(
      config.EMBEDDING_MODEL,
      config.OLLAMA_URL,
    );
    const result = reranker
      ? await retrieveEvidence(
          input,
          backend,
          embedder,
          reranker,
          rerankConfig.RERANK_TOP_K,
        )
      : {
          ...(await retrieve(input, backend, embedder)),
          reranking: { enabled: false },
        };
    // An explicit admin command: source content goes to stdout, never request logs.
    console.log(JSON.stringify(result, null, 2));
  } finally {
    try {
      await reranker?.dispose();
    } finally {
      await pool.end();
    }
  }
}
main().catch(() => {
  console.error(
    'Search failed. Check the question (1–2000 characters, at most 128 reranker tokens), database, Ollama model, and reranker cache/network configuration. Reranking failures do not silently return unreranked results.',
  );
  process.exitCode = 1;
});
