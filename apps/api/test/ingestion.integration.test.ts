import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../src/db/migrate.js';
import { DocumentStore } from '../src/ingestion/store.js';
import { ingestMarkdown } from '../src/ingestion/service.js';
import type { Embedder } from '../src/ingestion/embeddings.js';

import { ingestParsed } from '../src/sources/ingest.js';
import { parsePdf } from '../src/sources/parse.js';
import { makePdf } from './pdf-fixture.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('ingestion with real pgvector', () => {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  const store = new DocumentStore(pool);
  const keys: string[] = [];
  const input = () => {
    const key = 'test-' + randomUUID();
    keys.push(key);
    return {
      sourceKey: key,
      sourceUrl: 'https://example.com/guide',
      markdown: '# Guide\n\nVersion one.',
    };
  };
  const embedder: Embedder = {
    model: 'test-768',
    embed: async (texts) =>
      texts.map(() => Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0))),
  };
  beforeAll(async () => {
    await migrate(pool);
    await migrate(pool);
  });
  afterAll(async () => {
    for (const key of keys) {
      await store.delete(key);
      await pool.query(
        'DELETE FROM verascribe.ingestion_runs WHERE source_key=$1',
        [key],
      );
    }
    await pool.end();
  });
  it('skips duplicates, replaces versions and cascades deletion', async () => {
    const document = input();
    const first = await ingestMarkdown(document, store, embedder);
    const second = await ingestMarkdown(document, store, {
      ...embedder,
      embed: async () => {
        throw new Error('must not embed again');
      },
    });
    expect(second.status).toBe('skipped');
    expect(second.documentId).toBe(first.documentId);
    const updated = await ingestMarkdown(
      {
        ...document,
        markdown: '# Updated\n\nNew content.\n\n## Details\n\nMore content.',
      },
      store,
      embedder,
    );
    expect(updated.version).toBe(2);
    expect(updated.documentId).toBe(first.documentId);
    const chunks = await pool.query(
      'SELECT content, tsv FROM verascribe.chunks WHERE document_id=$1',
      [first.documentId],
    );
    expect(chunks.rowCount).toBe(updated.chunks);
    expect(
      chunks.rows.some((row) => String(row.content).includes('Version one')),
    ).toBe(false);
    expect(chunks.rows[0]?.tsv).toBeTruthy();
    expect(await store.delete(document.sourceKey)).toBe(true);
    expect(
      (
        await pool.query(
          'SELECT id FROM verascribe.chunks WHERE document_id=$1',
          [first.documentId],
        )
      ).rowCount,
    ).toBe(0);
  });
  it('preserves prior content on provider failure and records the failed run', async () => {
    const document = input();
    await ingestMarkdown(document, store, embedder);
    await expect(
      ingestMarkdown({ ...document, markdown: '# Replacement' }, store, {
        ...embedder,
        embed: async () => {
          throw new Error('provider offline');
        },
      }),
    ).rejects.toThrow();
    expect((await store.find(document.sourceKey))?.version).toBe(1);
    const runs = await pool.query(
      'SELECT status FROM verascribe.ingestion_runs WHERE source_key=$1',
      [document.sourceKey],
    );
    expect(runs.rows.map((row) => row.status)).toContain('failed');
  });
  it('rolls back a database failure after deleting the previous chunks', async () => {
    const document = input();
    const original = await ingestMarkdown(document, store, embedder);
    await expect(
      store.replace({
        ...document,
        title: 'Bad',
        fingerprint: 'different',
        model: embedder.model,
        chunks: [
          {
            content: '\0',
            metadata: { headings: [], startLine: 1, endLine: 1 },
          },
        ],
        vectors: await embedder.embed(['bad']),
      }),
    ).rejects.toThrow();
    expect((await store.find(document.sourceKey))?.version).toBe(1);
    expect(
      (
        await pool.query(
          'SELECT content FROM verascribe.chunks WHERE document_id=$1',
          [original.documentId],
        )
      ).rows[0]?.content,
    ).toContain('Version one');
  });
  it('stores PDF page provenance, skips duplicates, and preserves versions on failure', async () => {
    const document = input();
    const parsed = await parsePdf(
      makePdf(['Reset links last 30 minutes.', 'Contact support.']),
    );
    const source = {
      ...parsed,
      sourceKey: document.sourceKey,
      sourceUrl: 'https://example.com/guide.pdf',
    };
    const first = await ingestParsed(source, store, embedder);
    const duplicate = await ingestParsed(source, store, {
      ...embedder,
      embed: async () => {
        throw new Error('must skip');
      },
    });
    expect(duplicate.status).toBe('skipped');
    const rows = await pool.query(
      'SELECT metadata FROM verascribe.chunks WHERE document_id=$1 ORDER BY ordinal',
      [first.documentId],
    );
    expect(rows.rows.map((row) => row.metadata.page)).toEqual([1, 2]);
    expect(rows.rows[0]?.metadata.lineBasis).toBe('extracted');
    const updated = {
      ...source,
      chunks: [{ ...source.chunks[0]!, content: 'Changed PDF content.' }],
    };
    await expect(
      ingestParsed(updated, store, {
        ...embedder,
        embed: async () => {
          throw new Error('provider');
        },
      }),
    ).rejects.toThrow();
    expect((await store.find(source.sourceKey))?.version).toBe(1);
    expect((await ingestParsed(updated, store, embedder)).version).toBe(2);
  }, 30000);
  it('serializes simultaneous duplicate writes', async () => {
    const document = input();
    const results = await Promise.all([
      ingestMarkdown(document, store, embedder),
      ingestMarkdown(document, store, embedder),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'skipped',
      'succeeded',
    ]);
    expect((await store.find(document.sourceKey))?.version).toBe(1);
  });
});
