import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FALLBACK_ANSWER, type DraftAnswer } from '@verascribe/contracts';
import { extractClaims } from '../src/guardrails/claims.js';
import { verifyDraft } from '../src/guardrails/verify.js';
import {
  LocalNliVerifier,
  probabilitiesFromLogits,
  type EntailmentVerifier,
  type NliResult,
  type NliRuntime,
} from '../src/guardrails/nli.js';

const entailed: NliResult = {
  status: 'scored',
  probabilities: { entailment: 0.95, contradiction: 0.01, neutral: 0.04 },
};
const neutral: NliResult = {
  status: 'scored',
  probabilities: { entailment: 0.1, contradiction: 0.1, neutral: 0.8 },
};
const contradicted: NliResult = {
  status: 'scored',
  probabilities: { entailment: 0.01, contradiction: 0.98, neutral: 0.01 },
};
function draft(texts = ['First claim.', 'Second claim.']): DraftAnswer {
  return {
    status: 'draft',
    verification: 'pending',
    answer: 'UNTRUSTED ORIGINAL ANSWER',
    claims: texts.map((text) => ({ text, citationIds: [1] })),
    citations: [
      {
        id: 1,
        text: 'Evidence.',
        sourceUrl: 'https://example.com/guide',
        chunkId: randomUUID(),
        documentId: randomUUID(),
        title: 'Guide',
        version: 1,
        metadata: { headings: [], startLine: 1, endLine: 1 },
      },
    ],
  };
}
const verifier = (results: NliResult[]): EntailmentVerifier => ({
  model: 'test',
  revision: 'test',
  verify: vi.fn(async () => results),
});
describe('claim extraction', () => {
  it('splits sentences while retaining references and deduplicates repeated claims', () => {
    const result = extractClaims(
      draft(['First claim. Second claim.', 'First claim.']),
    );
    expect(result.claims).toEqual([
      { text: 'First claim.', citationIds: [1] },
      { text: 'Second claim.', citationIds: [1] },
    ]);
  });
  it('rejects missing and duplicate source references', () => {
    const input = draft();
    if (input.status !== 'draft') throw new Error('fixture');
    input.claims[0]!.citationIds = [99];
    expect(() => extractClaims(input)).toThrow();
    input.claims[0]!.citationIds = [1];
    input.citations.push(input.citations[0]!);
    expect(() => extractClaims(input)).toThrow('Duplicate');
  });
});
describe('evidence gate', () => {
  it('returns only verified text with model provenance and draft support coverage', async () => {
    const output = await verifyDraft(draft(), verifier([entailed, entailed]));
    expect(output.status).toBe('supported');
    expect(output.answer).toBe('First claim. [1]\nSecond claim. [1]');
    expect(output.confidence).toBe(1);
    expect(output.answer).not.toContain('UNTRUSTED');
    expect(output.verification).toMatchObject({
      assessedClaims: 2,
      supportedClaims: 2,
      returnedClaims: 2,
    });
  });
  it('strips unsupported claims at the inclusive 50% boundary', async () => {
    const result = await verifyDraft(draft(), verifier([entailed, neutral]));
    expect(result.status).toBe('partial');
    expect(result.answer).toBe('First claim. [1]');
    expect(JSON.stringify(result)).not.toContain('Second claim.');
    expect(result.confidence).toBe(0.5);
    expect(result.note).toBe('Unsupported statements were removed.');
  });
  it('returns fallback below the minimum ratio, without leaking even accepted text', async () => {
    const result = await verifyDraft(
      draft(['One.', 'Two.', 'Three.']),
      verifier([entailed, neutral, contradicted]),
    );
    expect(result.status).toBe('insufficient_evidence');
    expect(result.answer).toBe(FALLBACK_ANSWER);
    expect(result.claims).toEqual([]);
    expect(result.citations).toEqual([]);
    expect(result.confidence).toBeCloseTo(1 / 3);
    expect(result.verification.returnedClaims).toBe(0);
  });
  it('removes unsupported text even when draft support is 90%', async () => {
    const input = draft(
      Array.from({ length: 10 }, (_, i) => 'Claim ' + i + '.'),
    );
    const result = await verifyDraft(
      input,
      verifier([...Array<NliResult>(9).fill(entailed), neutral]),
    );
    expect(result.status).toBe('partial');
    expect(result.claims).toHaveLength(9);
    expect(result.answer).not.toContain('Claim 9.');
  });
  it('rejects conflicting cited evidence even if another source entails the claim', async () => {
    const input = draft(['A fact.']);
    if (input.status !== 'draft') throw new Error('fixture');
    input.citations.push({
      ...input.citations[0]!,
      id: 2,
      chunkId: randomUUID(),
      text: 'Conflicting evidence.',
    });
    input.claims[0]!.citationIds = [1, 2];
    expect(
      (await verifyDraft(input, verifier([entailed, contradicted]))).status,
    ).toBe('insufficient_evidence');
  });
  it('retains only the citations that support a kept claim', async () => {
    const input = draft(['A fact.']);
    if (input.status !== 'draft') throw new Error('fixture');
    input.citations.push({
      ...input.citations[0]!,
      id: 2,
      chunkId: randomUUID(),
    });
    input.claims[0]!.citationIds = [1, 2];
    const result = await verifyDraft(input, verifier([neutral, entailed]));
    expect(result.answer).toBe('A fact. [2]');
    expect(result.citations.map((citation) => citation.id)).toEqual([2]);
  });
  it('refuses overlong pairs and low-confidence entailment', async () => {
    const result = await verifyDraft(
      draft(),
      verifier([
        { status: 'input_too_long' },
        {
          status: 'scored',
          probabilities: { entailment: 0.6, neutral: 0.3, contradiction: 0.1 },
        },
      ]),
    );
    expect(result.status).toBe('insufficient_evidence');
    expect(result.verification.assessments.map((row) => row.outcome)).toEqual([
      'input_too_long',
      'not_entailed',
    ]);
  });
  it('allows stricter thresholds without accepting invalid policy settings', async () => {
    const result = await verifyDraft(draft(), verifier([entailed, neutral]), {
      minimumSupportRatio: 0.9,
    });
    expect(result.status).toBe('insufficient_evidence');
    await expect(
      verifyDraft(draft(), verifier([]), { entailmentThreshold: 0.1 }),
    ).rejects.toThrow();
  });
  it('does not load a verifier for a generation fallback', async () => {
    const model = verifier([]);
    const result = await verifyDraft(
      {
        status: 'insufficient_evidence',
        verification: 'not_applicable',
        answer: FALLBACK_ANSWER,
        claims: [],
        citations: [],
      },
      model,
    );
    expect(result.confidence).toBe(0);
    expect(model.verify).not.toHaveBeenCalled();
  });
  it('fails closed on invalid result counts or model failures', async () => {
    await expect(verifyDraft(draft(), verifier([entailed]))).rejects.toThrow(
      'count mismatch',
    );
    await expect(
      verifyDraft(draft(), {
        model: 'test',
        revision: 'test',
        verify: async () => {
          throw new Error('unavailable');
        },
      }),
    ).rejects.toThrow('unavailable');
  });
  it('honors cancellation even if a verifier ignores the signal', async () => {
    const controller = new AbortController();
    await expect(
      verifyDraft(
        draft(),
        {
          model: 'test',
          revision: 'test',
          verify: async () => {
            controller.abort();
            return [entailed, entailed];
          },
        },
        {},
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});
describe('NLI runtime boundary', () => {
  const runtime = (): NliRuntime => ({
    verify: vi.fn(async (pairs) => pairs.map(() => entailed)),
    dispose: vi.fn(async () => undefined),
  });
  it('uses numerically stable softmax and the verified label ordering', () => {
    expect(
      probabilitiesFromLogits([1000, 1002, 999]).entailment,
    ).toBeGreaterThan(0.8);
    expect(() => probabilitiesFromLogits([NaN, 0, 0])).toThrow();
  });
  it('batches, initializes once, and disposes once', async () => {
    const engine = runtime();
    const loader = vi.fn(async () => engine);
    const model = new LocalNliVerifier({ batchSize: 2 }, loader);
    await model.verify(
      Array(3).fill({ premise: 'Evidence', hypothesis: 'Claim' }),
    );
    await model.prepare();
    expect(engine.verify).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenCalledTimes(1);
    await model.dispose();
    await model.dispose();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    await expect(model.verify([])).rejects.toThrow('closed');
  });
  it('retries initialization failure and rejects invalid probabilities', async () => {
    const engine = runtime();
    const loader = vi
      .fn<() => Promise<NliRuntime>>()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValue(engine);
    const model = new LocalNliVerifier({}, loader);
    const pair = [{ premise: 'Evidence', hypothesis: 'Claim' }];
    await expect(model.verify(pair)).rejects.toThrow('failed');
    expect(await model.verify(pair)).toHaveLength(1);
    engine.verify = async () => [
      {
        status: 'scored',
        probabilities: { entailment: 1, neutral: 1, contradiction: 1 },
      },
    ];
    await expect(model.verify(pair)).rejects.toThrow();
    await model.dispose();
  });
  it('does not load for empty inputs and rejects overlapping inference', async () => {
    let release!: (value: NliRuntime) => void;
    const loader = vi.fn(
      () =>
        new Promise<NliRuntime>((resolve) => {
          release = resolve;
        }),
    );
    const model = new LocalNliVerifier({}, loader);
    expect(await model.verify([])).toEqual([]);
    expect(loader).not.toHaveBeenCalled();
    const pending = model.verify([
      { premise: 'Evidence', hypothesis: 'Claim' },
    ]);
    await expect(
      model.verify([{ premise: 'Evidence', hypothesis: 'Claim' }]),
    ).rejects.toThrow('busy');
    release(runtime());
    await pending;
    await model.dispose();
  });
});
