import 'dotenv/config';
import { Pool } from 'pg';
import { z } from 'zod';
import { OllamaEmbedder } from '../src/ingestion/embeddings.js';
import { PostgresSearch } from '../src/retrieval/postgres.js';
import { retrieve } from '../src/retrieval/service.js';

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
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 5000,
  });
  try {
    const result = await retrieve(
      { question, ...(sourceKeys.length ? { sourceKeys } : {}) },
      new PostgresSearch(pool),
      new OllamaEmbedder(config.EMBEDDING_MODEL, config.OLLAMA_URL),
    );
    // An explicit admin command: source content goes to stdout, never request logs.
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    'Search failed. Provide a question of 1–2000 characters and check the database, migrations, and Ollama model configuration.',
  );
  process.exitCode = 1;
});
