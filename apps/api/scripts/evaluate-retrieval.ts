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
import { createReranker, readRerankConfig } from '../src/reranking/config.js';
import {
  compareReranking,
  summarizeComparison,
} from '../src/reranking/evaluation.js';

async function main() {
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
  const rerankConfig = readRerankConfig();
  const reranker = rerankConfig.RERANK_ENABLED
    ? createReranker(rerankConfig)
    : undefined;
  const topK = rerankConfig.RERANK_TOP_K;
  const comparisons: Awaited<ReturnType<typeof compareReranking>>[] = [];
  let modelLoadMs = 0;
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
    if (reranker) {
      const loadStart = performance.now();
      await reranker.prepare();
      modelLoadMs = performance.now() - loadStart;
    }
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
        ...hit,
        sourceKey: hit.sourceKey.slice(namespace.length),
      }));
      rows.push({
        ...scoreRetrieval(testCase, candidates, topK),
        durationMs: performance.now() - start,
      });
      if (reranker)
        comparisons.push(
          await compareReranking(testCase, candidates, reranker, topK),
        );
    }
    console.log(
      JSON.stringify(
        {
          model: embedder.model,
          cutoff: topK,
          note: 'Recall is measured over top-k chunks. Unanswerable cases are diagnostic only. Reranking comparisons use the same candidates. Inference latency excludes model loading; the first call may include warmup.',
          summary: summarizeEvaluation(rows),
          results: rows,
          reranking: reranker
            ? {
                enabled: true,
                model: reranker.model,
                revision: reranker.revision,
                modelLoadMs,
                comparison: summarizeComparison(comparisons),
                results: comparisons,
              }
            : { enabled: false },
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
      try {
        await reranker?.dispose();
      } finally {
        await pool.end();
      }
    }
  }
}
main().catch(() => {
  console.error(
    'Evaluation failed. Use a migrated disposable EVAL_DATABASE_URL, a running Ollama model, and a valid reranker cache/network configuration. A database outage may require cleaning eval-prefixed fixtures.',
  );
  process.exitCode = 1;
});
