import { z } from 'zod';
import {
  FALLBACK_ANSWER,
  verifiedAnswerSchema,
  type DraftAnswer,
  type VerifiedAnswer,
} from '@verascribe/contracts';
import { extractClaims } from './claims.js';
import {
  nliResultSchema,
  type EntailmentVerifier,
  type NliPair,
} from './nli.js';

export const verificationPolicySchema = z
  .object({
    entailmentThreshold: z.number().min(0.5).max(1).default(0.8),
    minimumSupportRatio: z.number().min(0.5).max(1).default(0.5),
  })
  .strict();
export type VerificationPolicy = z.input<typeof verificationPolicySchema>;

export async function verifyDraft(
  input: DraftAnswer,
  verifier: EntailmentVerifier,
  options: VerificationPolicy = {},
  signal?: AbortSignal,
): Promise<VerifiedAnswer> {
  signal?.throwIfAborted();
  const policy = verificationPolicySchema.parse(options);
  const { draft, claims } = extractClaims(input);
  const sources = new Map(
    draft.citations.map((citation) => [citation.id, citation]),
  );
  const pairs: NliPair[] = claims.flatMap((claim) =>
    claim.citationIds.map((id) => ({
      premise: sources.get(id)!.text,
      hypothesis: claim.text,
    })),
  );
  const results = pairs.length
    ? z.array(nliResultSchema).parse(await verifier.verify(pairs))
    : [];
  signal?.throwIfAborted();
  if (results.length !== pairs.length)
    throw new Error('Verifier result count mismatch');
  let offset = 0;
  const accepted: { text: string; citationIds: number[] }[] = [];
  const assessments: {
    claimIndex: number;
    outcome: 'entailed' | 'contradicted' | 'not_entailed' | 'input_too_long';
  }[] = [];
  for (const [claimIndex, claim] of claims.entries()) {
    const supportedIds: number[] = [];
    let tooLong = false;
    let contradicted = false;
    for (const id of claim.citationIds) {
      const result = results[offset++]!;
      if (result.status === 'input_too_long') {
        tooLong = true;
        continue;
      }
      const p = result.probabilities;
      if (p.contradiction >= p.entailment && p.contradiction >= p.neutral)
        contradicted = true;
      if (
        p.entailment >= policy.entailmentThreshold &&
        p.entailment > p.contradiction &&
        p.entailment > p.neutral
      )
        supportedIds.push(id);
    }
    const outcome = contradicted
      ? 'contradicted'
      : tooLong
        ? 'input_too_long'
        : supportedIds.length
          ? 'entailed'
          : 'not_entailed';
    assessments.push({ claimIndex, outcome });
    if (outcome === 'entailed')
      accepted.push({ text: claim.text, citationIds: supportedIds });
  }
  const confidence = claims.length ? accepted.length / claims.length : 0;
  const returnClaims =
    accepted.length > 0 && confidence >= policy.minimumSupportRatio
      ? accepted
      : [];
  const keptIds = new Set(returnClaims.flatMap((claim) => claim.citationIds));
  // Rebuild exclusively from unchanged verified claim/source pairs. Never return
  // draft.answer or rejected text, and do not retain unsupported citation markers.
  const result: VerifiedAnswer = {
    status: returnClaims.length
      ? accepted.length === claims.length
        ? 'supported'
        : 'partial'
      : 'insufficient_evidence',
    answer: returnClaims.length
      ? returnClaims
          .map(
            (claim) =>
              claim.text +
              ' ' +
              claim.citationIds.map((id) => '[' + id + ']').join(''),
          )
          .join('\n')
      : FALLBACK_ANSWER,
    citations: draft.citations.filter((citation) => keptIds.has(citation.id)),
    confidence,
    claims: returnClaims,
    verification: {
      model: verifier.model,
      revision: verifier.revision,
      ...policy,
      assessedClaims: claims.length,
      supportedClaims: accepted.length,
      returnedClaims: returnClaims.length,
      assessments,
    },
    note:
      returnClaims.length && accepted.length !== claims.length
        ? 'Unsupported statements were removed.'
        : null,
  };
  return verifiedAnswerSchema.parse(result);
}
