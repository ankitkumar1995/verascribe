import 'dotenv/config';
import { Pool } from 'pg';
import { z } from 'zod';
import { OllamaEmbedder } from '../src/ingestion/embeddings.js';
import { PostgresSearch } from '../src/retrieval/postgres.js';
import { createReranker, readRerankConfig } from '../src/reranking/config.js';
import { GroqGenerator } from '../src/generation/groq.js';
import { answerVerified } from '../src/guardrails/pipeline.js';
import { createVerifierFromEnv } from '../src/guardrails/config.js';
import { GenerationError } from '../src/generation/types.js';

async function main() {
  const [question, ...sourceKeys] = process.argv.slice(2);
  if (!question) throw new Error('Missing question');
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
    })
    .parse(process.env);
  const reranker = createReranker(readRerankConfig());
  const generator = new GroqGenerator({
    apiKey: config.GROQ_API_KEY,
    model: config.GROQ_MODEL,
    timeoutMs: config.GENERATION_TIMEOUT_MS,
  });
  const { verifier, policy } = createVerifierFromEnv();
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 5000,
  });
  try {
    const result = await answerVerified(
      { question, ...(sourceKeys.length ? { sourceKeys } : {}) },
      {
        backend: new PostgresSearch(pool),
        embedder: new OllamaEmbedder(config.EMBEDDING_MODEL, config.OLLAMA_URL),
        reranker,
        generator,
        verifier,
      },
      policy,
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    try {
      try {
        await verifier.dispose();
      } finally {
        await reranker.dispose();
      }
    } finally {
      await pool.end();
    }
  }
}
main().catch((error) => {
  console.error(
    error instanceof GenerationError
      ? error.code + ': ' + error.message
      : 'Verified answer failed. Check the question, database, Ollama, reranker, NLI verifier, and server-side GROQ_API_KEY configuration.',
  );
  process.exitCode = 1;
});
