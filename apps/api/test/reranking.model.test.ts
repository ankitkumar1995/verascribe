import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CrossEncoderReranker } from '../src/reranking/local.js';

describe.skipIf(process.env.RUN_MODEL_TESTS !== 'true')(
  'real pinned CPU reranker',
  () => {
    const model = new CrossEncoderReranker();
    beforeAll(async () => {
      await model.prepare();
    }, 120000);
    afterAll(async () => {
      await model.dispose();
    });
    it('scores relevant evidence higher than an unrelated passage', async () => {
      const scores = await model.score('How many people live in Berlin?', [
        'New York City is famous for its museums.',
        'Berlin has a population of 3,520,031 inhabitants.',
      ]);
      expect(scores[1]!.score).toBeGreaterThan(scores[0]!.score);
      expect(scores.every((score) => !score.truncated)).toBe(true);
    }, 30000);
    it('flags token truncation while keeping one score per input', async () => {
      const scores = await model.score('What is the policy?', [
        'policy '.repeat(1000),
      ]);
      expect(scores).toHaveLength(1);
      expect(scores[0]?.truncated).toBe(true);
    }, 30000);
    it('rejects oversized tokenized questions rather than dropping question tokens', async () => {
      await expect(
        model.score('question '.repeat(150), ['Some passage']),
      ).rejects.toThrow('128');
    });
  },
);
