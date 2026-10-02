import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { LocalNliVerifier } from '../src/guardrails/nli.js';
import { verifyDraft } from '../src/guardrails/verify.js';

describe.skipIf(process.env.RUN_MODEL_TESTS !== 'true')(
  'real pinned NLI verifier',
  () => {
    const verifier = new LocalNliVerifier();
    beforeAll(async () => {
      await verifier.prepare();
    }, 120000);
    afterAll(async () => {
      await verifier.dispose();
    });
    it('distinguishes entailment, contradiction, and unknown attributes', async () => {
      const result = await verifier.verify([
        {
          premise: 'The cat is sleeping on the sofa.',
          hypothesis: 'The cat is asleep.',
        },
        {
          premise: 'The cat is sleeping on the sofa.',
          hypothesis: 'There is no cat.',
        },
        {
          premise: 'The cat is sleeping on the sofa.',
          hypothesis: 'The cat is black.',
        },
      ]);
      expect(
        result.map((item) =>
          item.status === 'scored'
            ? Object.entries(item.probabilities).sort(
                (a, b) => b[1] - a[1],
              )[0]?.[0]
            : item.status,
        ),
      ).toEqual(['entailment', 'contradiction', 'neutral']);
    }, 30000);
    it('refuses overlong evidence without losing the position of valid pairs', async () => {
      const result = await verifier.verify([
        { premise: 'text '.repeat(1000), hypothesis: 'A fact.' },
        { premise: 'The cat is asleep.', hypothesis: 'The cat is asleep.' },
      ]);
      expect(result[0]?.status).toBe('input_too_long');
      expect(result[1]?.status).toBe('scored');
    }, 30000);
    it('removes a contradicted claim from a draft with real model inference', async () => {
      const result = await verifyDraft(
        {
          status: 'draft',
          verification: 'pending',
          answer: 'Must not pass through',
          claims: [
            { text: 'The cat is asleep.', citationIds: [1] },
            { text: 'There is no cat.', citationIds: [1] },
          ],
          citations: [
            {
              id: 1,
              text: 'The cat is sleeping on the sofa.',
              sourceUrl: 'https://example.com/cat',
              chunkId: randomUUID(),
              documentId: randomUUID(),
              version: 1,
              title: 'Cat',
              metadata: { headings: [], startLine: 1, endLine: 1 },
            },
          ],
        },
        verifier,
      );
      expect(result.status).toBe('partial');
      expect(result.answer).toBe('The cat is asleep. [1]');
      expect(result.confidence).toBe(0.5);
    }, 30000);
  },
);
