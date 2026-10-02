import { describe, expect, it, vi } from 'vitest';
import { reciprocalRankFusion } from '../src/retrieval/fusion.js';
import { retrieve } from '../src/retrieval/service.js';
import {
  evaluationDatasetSchema,
  scoreRetrieval,
  summarizeEvaluation,
} from '../src/retrieval/evaluation.js';
import type { RankedChunk, SearchBackend } from '../src/retrieval/types.js';
import type { QueryEmbedder } from '../src/ingestion/embeddings.js';

const hit = (chunkId: string, score = 1): RankedChunk => ({
  chunkId,
  documentId: 'doc',
  sourceKey: chunkId,
  sourceUrl: 'https://example.com',
  title: 'Title',
  version: 1,
  ordinal: 0,
  content: 'Text',
  metadata: { headings: [], startLine: 1, endLine: 1 },
  score,
});
describe('reciprocal rank fusion', () => {
  it('rewards agreement without mixing unrelated raw score scales', () => {
    const results = reciprocalRankFusion(
      [hit('a', 0.9), hit('b', 0.8)],
      [hit('b', 100), hit('c', 90)],
    );
    expect(results.map((item) => item.chunkId)).toEqual(['b', 'a', 'c']);
    expect(results[0]?.rrfScore).toBeCloseTo(1 / 62 + 1 / 61);
    expect(results[0]).toMatchObject({
      denseRank: 2,
      sparseRank: 1,
      cosineSimilarity: 0.8,
      textScore: 100,
    });
  });
  it('does not double-count duplicates within one leg', () => {
    expect(reciprocalRankFusion([hit('a'), hit('a'), hit('b')], [])).toEqual(
      reciprocalRankFusion([hit('a'), hit('b')], []),
    );
  });
  it('breaks ties deterministically and handles one or two empty legs', () => {
    expect(reciprocalRankFusion([hit('z')], [hit('a')], 1)[0]?.chunkId).toBe(
      'a',
    );
    expect(reciprocalRankFusion([], [hit('a')])[0]?.denseRank).toBeNull();
    expect(reciprocalRankFusion([], [])).toEqual([]);
    expect(() => reciprocalRankFusion([], [], 0)).toThrow();
    expect(() => reciprocalRankFusion([], [], 5, 0)).toThrow();
  });
});

describe('retrieval orchestration', () => {
  const vector = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
  const createDependencies = () => ({
    backend: {
      search: vi.fn<SearchBackend['search']>(async () => ({
        dense: [hit('a')],
        sparse: [],
      })),
    },
    embedder: {
      model: 'test-model',
      embedQuery: vi.fn<QueryEmbedder['embedQuery']>(async () => vector),
    },
  });
  it('validates before calling providers or the database', async () => {
    const { backend, embedder } = createDependencies();
    for (const input of [
      { question: ' ' },
      { question: 'x'.repeat(2001) },
      { question: 'x', limit: 31 },
      { question: 'x', candidateLimit: 101 },
      { question: 'x\0' },
    ]) {
      await expect(retrieve(input, backend, embedder)).rejects.toThrow();
    }
    expect(embedder.embedQuery).not.toHaveBeenCalled();
    expect(backend.search).not.toHaveBeenCalled();
  });
  it('treats an explicitly empty source scope as empty, never global', async () => {
    const { backend, embedder } = createDependencies();
    expect(
      (await retrieve({ question: 'hello', sourceKeys: [] }, backend, embedder))
        .candidates,
    ).toEqual([]);
    expect(embedder.embedQuery).not.toHaveBeenCalled();
    expect(backend.search).not.toHaveBeenCalled();
  });
  it('uses query embeddings and passes the model and scope to both search legs', async () => {
    const { backend, embedder } = createDependencies();
    await retrieve(
      { question: ' hello ', sourceKeys: ['guide'] },
      backend,
      embedder,
    );
    expect(embedder.embedQuery).toHaveBeenCalledWith('hello');
    expect(backend.search).toHaveBeenCalledWith(vector, 'test-model', {
      question: 'hello',
      sourceKeys: ['guide'],
      limit: 30,
      candidateLimit: 30,
    });
  });
  it('fails closed on invalid embeddings and provider failure', async () => {
    const { backend, embedder } = createDependencies();
    embedder.embedQuery.mockResolvedValueOnce([1, 2]);
    await expect(
      retrieve({ question: 'hello' }, backend, embedder),
    ).rejects.toThrow();
    embedder.embedQuery.mockRejectedValueOnce(new Error('offline'));
    await expect(
      retrieve({ question: 'hello' }, backend, embedder),
    ).rejects.toThrow('offline');
    expect(backend.search).not.toHaveBeenCalled();
  });
  it('propagates database failure rather than disguising it as no evidence', async () => {
    const { backend, embedder } = createDependencies();
    backend.search.mockRejectedValueOnce(new Error('database offline'));
    await expect(
      retrieve({ question: 'hello' }, backend, embedder),
    ).rejects.toThrow('database offline');
  });
});

describe('retrieval evaluation', () => {
  it('scores document recall over top-k chunks without duplicate credit', () => {
    const result = scoreRetrieval(
      {
        id: 'q',
        question: '?',
        category: 'ambiguous',
        relevantSources: ['a', 'b'],
      },
      [
        { sourceKey: 'x' },
        { sourceKey: 'a' },
        { sourceKey: 'a' },
        { sourceKey: 'b' },
      ],
      3,
    );
    expect(result.recallAtK).toBe(0.5);
    expect(result.reciprocalRankAtK).toBe(0.5);
  });
  it('does not award perfect recall or infer abstention for unanswerable cases', () => {
    const result = scoreRetrieval(
      { id: 'q', question: '?', category: 'unanswerable', relevantSources: [] },
      [{ sourceKey: 'a' }],
    );
    expect(result.recallAtK).toBeNull();
    expect(result.candidateCount).toBe(1);
    expect(summarizeEvaluation([result])).toMatchObject({
      scoredCases: 0,
      meanRecallAtK: null,
      unanswerableCases: 1,
    });
  });
  it('rejects broken relevance labels', () => {
    expect(
      evaluationDatasetSchema.safeParse({
        documents: [{ key: 'a', markdown: 'Text' }],
        cases: [
          {
            id: 'q',
            question: '?',
            category: 'answerable',
            relevantSources: ['missing'],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
