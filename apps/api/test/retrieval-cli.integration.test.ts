import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../src/db/migrate.js';
import { DocumentStore } from '../src/ingestion/store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const execute = promisify(execFile);
describe.skipIf(!databaseUrl)(
  'retrieval CLI with controlled HTTP embeddings and real pgvector',
  () => {
    const pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5000,
    });
    const store = new DocumentStore(pool);
    const sourceKey = 'cli-' + randomUUID();
    const model = 'nomic-embed-text:test-' + randomUUID();
    const vector = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
    const received: string[] = [];
    let server: Server;
    let ollamaUrl: string;
    beforeAll(async () => {
      await migrate(pool);
      await store.replace({
        sourceKey,
        sourceUrl: 'https://example.com/guide',
        title: 'Guide',
        fingerprint: 'v1',
        model,
        chunks: [
          {
            content: 'Password recovery instructions.',
            metadata: { headings: ['Guide'], startLine: 1, endLine: 2 },
          },
        ],
        vectors: [vector],
      });
      server = createServer(async (req, res) => {
        try {
          const parts = [];
          for await (const part of req) parts.push(Buffer.from(part));
          const data = JSON.parse(Buffer.concat(parts).toString()) as {
            input: string[];
          };
          received.push(...data.input);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ embeddings: data.input.map(() => vector) }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing test server address');
      ollamaUrl = 'http://127.0.0.1:' + address.port;
    });
    afterAll(async () => {
      if (server)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await store.delete(sourceKey);
      await pool.end();
    });
    function run(script: string, args: string[] = []) {
      return execute(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('../scripts/' + script, import.meta.url)),
          ...args,
        ],
        {
          cwd: fileURLToPath(new URL('../../../', import.meta.url)),
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl!,
            EVAL_DATABASE_URL: databaseUrl!,
            OLLAMA_URL: ollamaUrl,
            EMBEDDING_MODEL: model,
            DOTENV_CONFIG_QUIET: 'true',
          },
          timeout: 20000,
        },
      );
    }
    it('searches from the command line using the query prefix and source scope', async () => {
      const output = await run('search.ts', ['password', sourceKey]);
      const result = JSON.parse(output.stdout);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({
        sourceKey,
        title: 'Guide',
        version: 1,
      });
      expect(received).toContain('search_query: password');
    }, 30000);
    it('runs all dataset cases and removes evaluation fixtures without removing existing documents', async () => {
      const output = await run('evaluate-retrieval.ts');
      const report = JSON.parse(output.stdout);
      expect(report.summary).toMatchObject({
        cases: 11,
        scoredCases: 9,
        unanswerableCases: 2,
      });
      expect(report.results).toHaveLength(11);
      expect(
        received.some((text) => text.startsWith('search_document: ')),
      ).toBe(true);
      expect(
        (
          await pool.query(
            'SELECT source_key FROM verascribe.documents WHERE embedding_model=$1',
            [model],
          )
        ).rows,
      ).toEqual([{ source_key: sourceKey }]);
      // Controlled vectors exercise plumbing, not semantic accuracy.
    }, 30000);
  },
);
