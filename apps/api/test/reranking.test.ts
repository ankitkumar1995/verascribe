import { describe, expect, it, vi } from 'vitest';
import {
  CrossEncoderReranker,
  type PairScorer,
  type RerankRuntime,
} from '../src/reranking/local.js';
import { rerank } from '../src/reranking/service.js';
import {
  compareReranking,
  summarizeComparison,
} from '../src/reranking/evaluation.js';
import { readRerankConfig } from '../src/reranking/config.js';
import { retrieveEvidence } from '../src/reranking/pipeline.js';
import type { FusedChunk } from '../src/retrieval/types.js';

export const candidate = (chunkId: string): FusedChunk => ({
  chunkId,
  documentId: 'doc-' + chunkId,
  sourceKey: chunkId,
  sourceUrl: 'https://example.com/' + chunkId,
  title: chunkId,
  version: 2,
  ordinal: 0,
  content: 'Passage ' + chunkId,
  metadata: { headings: [chunkId], startLine: 3, endLine: 4 },
  rrfScore: 0.01,
  denseRank: 1,
  sparseRank: null,
  cosineSimilarity: 0.8,
  textScore: null,
});
const scorer = (scores: number[]): PairScorer => ({
  model: 'test',
  revision: 'test',
  score: vi.fn(async () =>
    scores.map((score) => ({ score, truncated: false })),
  ),
});

describe('reranking service', () => {
  it('selects the highest scores and preserves source metadata without mutating input', async () => {
    const candidates = [candidate('a'), candidate('b'), candidate('c')];
    const original = structuredClone(candidates);
    const output = await rerank('question', candidates, scorer([-1, 9, 3]), 2);
    expect(output.map((item) => item.chunkId)).toEqual(['b', 'c']);
    expect(output[0]).toMatchObject({
      ...candidates[1],
      retrievalRank: 2,
      rerankScore: 9,
    });
    expect(candidates).toEqual(original);
  });
  it('preserves retrieval order on ties, and accepts fewer candidates than top-k', async () => {
    expect(
      (
        await rerank(
          'question',
          [candidate('b'), candidate('a')],
          scorer([2, 2]),
        )
      ).map((item) => item.chunkId),
    ).toEqual(['b', 'a']);
  });
  it('does not load a model for empty evidence', async () => {
    const model = scorer([]);
    expect(await rerank('question', [], model)).toEqual([]);
    expect(model.score).not.toHaveBeenCalled();
  });
  it('rejects duplicate candidates, invalid top-k, and invalid scores', async () => {
    await expect(
      rerank('question', [candidate('a'), candidate('a')], scorer([1, 2])),
    ).rejects.toThrow('Duplicate');
    await expect(rerank('question', [], scorer([]), 0)).rejects.toThrow();
    for (const scores of [[], [NaN], [Infinity]]) {
      await expect(
        rerank('question', [candidate('a')], scorer(scores)),
      ).rejects.toThrow();
    }
  });
  it('does not hide scorer failures', async () => {
    await expect(
      rerank('question', [candidate('a')], {
        model: 'test',
        revision: 'test',
        score: async () => {
          throw new Error('offline');
        },
      }),
    ).rejects.toThrow('offline');
  });
});

describe('local model lifecycle and batches', () => {
  const runtime = (): RerankRuntime => ({
    score: vi.fn(async (_question: string, passages: string[]) =>
      passages.map((_, i) => ({ score: i, truncated: false })),
    ),
    dispose: vi.fn(async () => undefined),
  });
  it('loads once, batches in order, validates outputs, and disposes once', async () => {
    const engine = runtime();
    const loader = vi.fn(async () => engine);
    const model = new CrossEncoderReranker({ batchSize: 2 }, loader);
    const result = await model.score('question', ['a', 'b', 'c']);
    expect(result.map((item) => item.score)).toEqual([0, 1, 0]);
    await model.score('question', ['d']);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(engine.score).toHaveBeenCalledTimes(3);
    await model.dispose();
    await model.dispose();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    await expect(model.score('question', ['a'])).rejects.toThrow('closed');
  });
  it('can retry after initialization failure', async () => {
    const loader = vi
      .fn<() => Promise<RerankRuntime>>()
      .mockRejectedValueOnce(new Error('download failed'))
      .mockResolvedValue(runtime());
    const model = new CrossEncoderReranker({}, loader);
    await expect(model.score('question', ['a'])).rejects.toThrow(
      'download failed',
    );
    expect(await model.score('question', ['a'])).toHaveLength(1);
    await model.dispose();
  });
  it('rejects concurrent inference rather than queueing unbounded work', async () => {
    let release!: (engine: RerankRuntime) => void;
    const model = new CrossEncoderReranker(
      {},
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = model.score('question', ['a']);
    await expect(model.score('question', ['b'])).rejects.toThrow('busy');
    await expect(model.dispose()).rejects.toThrow('busy');
    release(runtime());
    await first;
    await model.dispose();
  });
  it('does not initialize for invalid or empty inputs', async () => {
    const loader = vi.fn(async () => runtime());
    const model = new CrossEncoderReranker({}, loader);
    expect(await model.score('question', [])).toEqual([]);
    await expect(model.score(' ', ['a'])).rejects.toThrow();
    await expect(
      model.score('question', Array(101).fill('text')),
    ).rejects.toThrow();
    expect(loader).not.toHaveBeenCalled();
  });
  it('rejects incorrect batch counts and nonfinite scores', async () => {
    const engine = runtime();
    engine.score = async () => [];
    const model = new CrossEncoderReranker({}, async () => engine);
    await expect(model.score('question', ['a'])).rejects.toThrow(
      'count mismatch',
    );
    engine.score = async () => [{ score: Infinity, truncated: false }];
    await expect(model.score('question', ['a'])).rejects.toThrow();
    await model.dispose();
  });
});

describe('pipeline and evaluation comparisons', () => {
  it('retrieves 30 candidates before selecting the configured top-k', async () => {
    const search = vi.fn(async () => ({
      dense: [
        { ...candidate('a'), score: 1 },
        { ...candidate('b'), score: 0.5 },
      ],
      sparse: [],
    }));
    const result = await retrieveEvidence(
      { question: 'question' },
      { search },
      {
        model: 'embedding',
        embedQuery: async () => [1, ...Array<number>(767).fill(0)],
      },
      scorer([0, 5]),
      1,
    );
    expect(search.mock.calls[0]).toBeDefined();
    expect(result.candidates[0]?.chunkId).toBe('b');
    expect(result.reranking).toMatchObject({ topK: 1, candidateCount: 2 });
  });
  it('compares identical candidates at the same cutoff and reports latency', async () => {
    const row = await compareReranking(
      {
        id: 'q',
        question: 'question',
        category: 'answerable',
        relevantSources: ['b'],
      },
      [candidate('a'), candidate('b')],
      scorer([0, 5]),
      1,
    );
    const summary = summarizeComparison([row]);
    expect(summary.recallDelta).toBe(1);
    expect(summary.mrrDelta).toBe(1);
    expect(summary.meanRerankMs).toBeGreaterThanOrEqual(0);
    expect(summarizeComparison([]).meanRerankMs).toBeNull();
  });
  it('parses explicit false and bounds top-k', () => {
    expect(readRerankConfig({ RERANK_ENABLED: 'false' }).RERANK_ENABLED).toBe(
      false,
    );
    expect(() => readRerankConfig({ RERANK_TOP_K: '31' })).toThrow();
    expect(() => readRerankConfig({ RERANK_ENABLED: 'no' })).toThrow();
  });
});
