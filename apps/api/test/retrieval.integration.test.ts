import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../src/db/migrate.js';
import { DocumentStore } from '../src/ingestion/store.js';
import { PostgresSearch } from '../src/retrieval/postgres.js';
import { retrieve } from '../src/retrieval/service.js';
import { retrievalRequestSchema } from '../src/retrieval/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('hybrid retrieval with real pgvector', () => {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 3,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  const store = new DocumentStore(pool);
  const backend = new PostgresSearch(pool);
  const namespace = 'retrieval-' + randomUUID() + ':';
  const model = namespace + 'model';
  const vector = (x: number, y: number) => [
    x,
    y,
    ...Array<number>(766).fill(0),
  ];
  const keys = ['semantic', 'lexical', 'both', 'wrong-model'].map(
    (key) => namespace + key,
  );
  async function save(
    index: number,
    content: string,
    embedding: number[],
    modelName = model,
  ) {
    const sourceKey = keys[index]!;
    return store.replace({
      sourceKey,
      sourceUrl: 'https://example.com/' + index,
      title: 'Source ' + index,
      fingerprint: content,
      model: modelName,
      chunks: [
        {
          content,
          metadata: { headings: ['Source ' + index], startLine: 1, endLine: 3 },
        },
      ],
      vectors: [embedding],
    });
  }
  beforeAll(async () => {
    await migrate(pool);
    await save(
      0,
      'Regain access to your account using a recovery link.',
      vector(1, 0),
    );
    await save(
      1,
      'Password password password reset instructions.',
      vector(0, 1),
    );
    await save(2, 'Password reset recovers account access.', vector(0.9, 0.1));
    await save(
      3,
      'Password reset instructions.',
      vector(1, 0),
      'incompatible-' + model,
    );
  });
  afterAll(async () => {
    for (const key of keys) await store.delete(key);
    await pool.end();
  });
  const options = (question = 'password reset') =>
    retrievalRequestSchema.parse({ question, sourceKeys: keys });
  it('retrieves complementary vector and lexical matches, preserving source identity', async () => {
    const result = await backend.search(vector(1, 0), model, options());
    expect(result.dense[0]?.sourceKey).toBe(keys[0]);
    expect(result.sparse.map((hit) => hit.sourceKey)).not.toContain(keys[0]);
    expect(result.sparse.map((hit) => hit.sourceKey)).toContain(keys[1]);
    const fused = await retrieve(
      { question: 'password reset', sourceKeys: keys },
      backend,
      {
        model,
        embedQuery: async () => vector(1, 0),
      },
    );
    expect(fused.candidates).toHaveLength(3);
    expect(fused.candidates[0]?.sourceKey).not.toBe(keys[0]);
    expect(fused.candidates[0]).toMatchObject({
      version: 1,
      metadata: { startLine: 1, endLine: 3 },
    });
    expect(new Set(fused.candidates.map((hit) => hit.chunkId)).size).toBe(3);
  });
  it('excludes incompatible models in both legs and handles no matching model', async () => {
    const result = await backend.search(vector(1, 0), model, options());
    expect(
      [...result.dense, ...result.sparse].map((hit) => hit.sourceKey),
    ).not.toContain(keys[3]);
    expect(
      await backend.search(vector(1, 0), model + '-absent', options()),
    ).toEqual({ dense: [], sparse: [] });
  });
  it('applies a source scope before ranking and limits both legs', async () => {
    const result = await backend.search(
      vector(1, 0),
      model,
      retrievalRequestSchema.parse({
        question: 'password',
        sourceKeys: [keys[1]!],
        limit: 1,
        candidateLimit: 1,
      }),
    );
    expect(result.dense.map((hit) => hit.sourceKey)).toEqual([keys[1]]);
    expect(result.sparse.map((hit) => hit.sourceKey)).toEqual([keys[1]]);
    expect(
      await backend.search(vector(1, 0), model, {
        ...options(),
        sourceKeys: [],
      }),
    ).toEqual({ dense: [], sparse: [] });
  });
  it('allows stopwords and punctuation without SQL syntax errors', async () => {
    for (const question of [
      'the and is',
      '""" )(',
      "'; DROP TABLE verascribe.documents; --",
    ]) {
      const result = await backend.search(
        vector(1, 0),
        model,
        options(question),
      );
      expect(result.dense).toHaveLength(3);
    }
    expect(
      (await backend.search(vector(1, 0), model, options('the and is'))).sparse,
    ).toEqual([]);
    expect(await store.find(keys[0]!)).toBeDefined();
  });
  it('honors phrase and OR lexical queries', async () => {
    const result = await backend.search(
      vector(1, 0),
      model,
      options('"recovery link" OR instructions'),
    );
    expect(result.sparse.map((hit) => hit.sourceKey).sort()).toEqual(
      [keys[0], keys[1]].sort(),
    );
  });
  it('does not mutate data and returns stable ties', async () => {
    const first = await backend.search(vector(1, 1), model, options());
    const second = await backend.search(vector(1, 1), model, options());
    expect(second).toEqual(first);
    expect((await store.find(keys[0]!))?.version).toBe(1);
  });
  it('reflects document updates and deletions without stale chunks', async () => {
    const key = namespace + 'changing';
    keys.push(key);
    const input = {
      sourceKey: key,
      sourceUrl: 'https://example.com/change',
      title: 'Changing',
      model,
      chunks: [
        {
          content: 'quartzmarker',
          metadata: { headings: [], startLine: 1, endLine: 1 },
        },
      ],
      vectors: [vector(1, 0)],
    };
    await store.replace({ ...input, fingerprint: 'v1' });
    const scoped = retrievalRequestSchema.parse({
      question: 'quartzmarker',
      sourceKeys: [key],
    });
    expect(
      (await backend.search(vector(1, 0), model, scoped)).sparse,
    ).toHaveLength(1);
    await store.replace({
      ...input,
      fingerprint: 'v2',
      chunks: [{ ...input.chunks[0]!, content: 'Updated evidence' }],
    });
    const updated = await backend.search(vector(1, 0), model, scoped);
    expect(updated.sparse).toEqual([]);
    expect(updated.dense[0]?.version).toBe(2);
    await store.delete(key);
    expect(await backend.search(vector(1, 0), model, scoped)).toEqual({
      dense: [],
      sparse: [],
    });
  });
});
