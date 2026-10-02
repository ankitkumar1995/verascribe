import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../src/db/migrate.js';
import { DocumentStore } from '../src/ingestion/store.js';
import { makePdf } from './pdf-fixture.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('PDF ingestion CLI', () => {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
  });
  const store = new DocumentStore(pool);
  const key = 'pdf-cli-' + randomUUID();
  let server: Server;
  let directory: string;
  let ollamaUrl: string;
  beforeAll(async () => {
    await migrate(pool);
    directory = await mkdtemp(join(tmpdir(), 'verascribe-pdf-'));
    await writeFile(
      join(directory, 'source.pdf'),
      makePdf(['Password links expire in 30 minutes.']),
    );
    server = createServer(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(parts).toString()) as {
        input: string[];
      };
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          embeddings: body.input.map(() => [1, ...Array<number>(767).fill(0)]),
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing address');
    ollamaUrl = 'http://127.0.0.1:' + address.port;
  });
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.delete(key);
    await pool.query(
      'DELETE FROM verascribe.ingestion_runs WHERE source_key=$1',
      [key],
    );
    await pool.end();
    if (directory) {
      await rm(join(directory, 'source.pdf'), { force: true });
      await rmdir(directory);
    }
  });
  it('runs file reading, isolated parsing, HTTP embeddings and atomic storage', async () => {
    const execute = promisify(execFile);
    const args = [
      '--import',
      'tsx',
      fileURLToPath(new URL('../scripts/ingest-source.ts', import.meta.url)),
      'pdf',
      join(directory, 'source.pdf'),
      key,
    ];
    const options = {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl!,
        OLLAMA_URL: ollamaUrl,
        EMBEDDING_MODEL: 'test-' + key,
        DOTENV_CONFIG_QUIET: 'true',
      },
      timeout: 30000,
    };
    expect(
      JSON.parse((await execute(process.execPath, args, options)).stdout)
        .status,
    ).toBe('succeeded');
    expect(
      JSON.parse((await execute(process.execPath, args, options)).stdout)
        .status,
    ).toBe('skipped');
    const document = await store.find(key);
    const row = await pool.query(
      'SELECT metadata FROM verascribe.chunks WHERE document_id=$1',
      [document!.id],
    );
    expect(row.rows[0]?.metadata.page).toBe(1);
  }, 60000);
});
