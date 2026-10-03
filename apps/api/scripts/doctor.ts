import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { z } from 'zod';
import { createReranker, readRerankConfig } from '../src/reranking/config.js';
import { createVerifierFromEnv } from '../src/guardrails/config.js';
import { runDiagnostics } from '../src/operations/doctor.js';
async function main() {
  const cache = fileURLToPath(
    new URL('../../../.local/models/', import.meta.url),
  );
  const checks = [
    {
      name: 'database',
      success: 'Database and ingestion tables are available.',
      failure: 'Database check failed. Check DATABASE_URL and run migrations.',
      run: async () => {
        const pool = new Pool({
          connectionString: z.string().url().parse(process.env.DATABASE_URL),
          max: 1,
          connectionTimeoutMillis: 5000,
          statement_timeout: 5000,
        });
        try {
          await pool.query(
            'SELECT d.id, c.embedding FROM verascribe.documents d LEFT JOIN verascribe.chunks c ON c.document_id=d.id LIMIT 0',
          );
        } finally {
          await pool.end();
        }
      },
    },
    {
      name: 'ollama',
      success: 'Configured embedding model is installed.',
      failure:
        'Embedding model unavailable. Start Ollama and pull the configured model.',
      run: async () => {
        const url = z
          .string()
          .url()
          .parse(process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434');
        const response = await fetch(new URL('/api/tags', url), {
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
        if (!response.ok) throw new Error();
        const text = await response.text();
        if (text.length > 65536) throw new Error();
        const data = z
          .object({ models: z.array(z.object({ name: z.string() })) })
          .parse(JSON.parse(text));
        const model = process.env.EMBEDDING_MODEL ?? 'nomic-embed-text';
        if (
          !data.models.some(
            (item) => item.name === model || item.name === model + ':latest',
          )
        )
          throw new Error();
      },
    },
    {
      name: 'reranker',
      success: 'Pinned reranker loads from the local cache.',
      failure: 'Reranker cache/configuration failed. Run npm run rerank:smoke.',
      run: async () => {
        const model = createReranker(
          readRerankConfig({
            ...process.env,
            RERANK_CACHE_DIR: process.env.RERANK_CACHE_DIR ?? cache,
            RERANK_LOCAL_FILES_ONLY: 'true',
          }),
        );
        try {
          await model.prepare();
        } finally {
          await model.dispose();
        }
      },
    },
    {
      name: 'verifier',
      success: 'Pinned verifier loads from the local cache.',
      failure: 'Verifier cache/configuration failed. Run npm run verify:smoke.',
      run: async () => {
        const { verifier } = createVerifierFromEnv({
          ...process.env,
          NLI_CACHE_DIR: process.env.NLI_CACHE_DIR ?? cache,
          NLI_LOCAL_FILES_ONLY: 'true',
        });
        try {
          await verifier.prepare();
        } finally {
          await verifier.dispose();
        }
      },
    },
    {
      name: 'generation-config',
      success: 'A generation key is configured (not validated remotely).',
      failure: 'Set a server-side GROQ_API_KEY before answering.',
      run: async () => {
        z.string().trim().min(1).parse(process.env.GROQ_API_KEY);
      },
    },
  ];
  const report = await runDiagnostics(checks);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
}
main().catch(() => {
  console.error('Diagnostics failed. Check local runtime configuration.');
  process.exitCode = 1;
});
