import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { OllamaEmbedder } from '../src/ingestion/embeddings.js';
import { DocumentStore } from '../src/ingestion/store.js';
import { ingestMarkdown } from '../src/ingestion/service.js';
import { PostgresSearch } from '../src/retrieval/postgres.js';
import { retrieve } from '../src/retrieval/service.js';
import {
  evaluationDatasetSchema,
  scoreRetrieval,
  summarizeEvaluation,
} from '../src/retrieval/evaluation.js';

async function main() {
  // A separate explicit URL prevents accidental writes to the app database.
  const config = z
    .object({
      EVAL_DATABASE_URL: z.string().url(),
      OLLAMA_URL: z.string().url().default('http://127.0.0.1:11434'),
      EMBEDDING_MODEL: z.string().min(1).default('nomic-embed-text'),
    })
    .parse(process.env);
  const dataset = evaluationDatasetSchema.parse(
    JSON.parse(
      await readFile(
        new URL('../../../eval/retrieval.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  const pool = new Pool({
    connectionString: config.EVAL_DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
  });
  const store = new DocumentStore(pool);
  const embedder = new OllamaEmbedder(
    config.EMBEDDING_MODEL,
    config.OLLAMA_URL,
  );
  const backend = new PostgresSearch(pool);
  const namespace = 'eval-' + randomUUID() + ':';
  const sourceKeys = dataset.documents.map((doc) => namespace + doc.key);
  try {
    for (const document of dataset.documents) {
      await ingestMarkdown(
        {
          sourceKey: namespace + document.key,
          sourceUrl:
            'https://example.com/verascribe-eval/' +
            encodeURIComponent(document.key),
          markdown: document.markdown,
        },
        store,
        embedder,
      );
    }
    const rows = [];
    for (const testCase of dataset.cases) {
      const start = performance.now();
      const result = await retrieve(
        { question: testCase.question, sourceKeys },
        backend,
        embedder,
      );
      const candidates = result.candidates.map((hit) => ({
        sourceKey: hit.sourceKey.slice(namespace.length),
      }));
      rows.push({
        ...scoreRetrieval(testCase, candidates),
        durationMs: Math.round(performance.now() - start),
      });
    }
    console.log(
      JSON.stringify(
        {
          model: embedder.model,
          cutoff: 5,
          note: 'Document recall over the first five chunks; unanswerable cases are diagnostic only, not an abstention test.',
          summary: summarizeEvaluation(rows),
          results: rows,
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      for (const sourceKey of sourceKeys) {
        await store.delete(sourceKey);
        await pool.query(
          'DELETE FROM verascribe.ingestion_runs WHERE source_key=$1',
          [sourceKey],
        );
      }
    } finally {
      await pool.end();
    }
  }
}
main().catch(() => {
  console.error(
    'Evaluation failed. Use a migrated disposable EVAL_DATABASE_URL and a running Ollama embedding model. Cleanup may require removing eval-prefixed fixtures after a database outage.',
  );
  process.exitCode = 1;
});
