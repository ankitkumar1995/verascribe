import { draftAnswerSchema, type DraftAnswer } from '@verascribe/contracts';

export type Claim = { text: string; citationIds: number[] };
export function extractClaims(input: DraftAnswer): {
  draft: DraftAnswer;
  claims: Claim[];
} {
  const draft = draftAnswerSchema.parse(input);
  if (draft.status === 'insufficient_evidence') return { draft, claims: [] };
  if (draft.claims.length > 12 || draft.citations.length > 10)
    throw new Error('Draft exceeds verification limits');
  const ids = new Set(draft.citations.map((citation) => citation.id));
  if (
    ids.size !== draft.citations.length ||
    new Set(draft.citations.map((citation) => citation.chunkId)).size !==
      draft.citations.length
  ) {
    throw new Error('Duplicate draft citations');
  }
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const byText = new Map<string, Claim>();
  for (const claim of draft.claims) {
    if (
      claim.text.length > 1500 ||
      claim.citationIds.length > 10 ||
      claim.citationIds.some((id) => !ids.has(id))
    )
      throw new Error('Invalid draft claim');
    for (const sentence of segmenter.segment(claim.text)) {
      const text = sentence.segment.trim().replace(/\s+/g, ' ');
      if (!text || text.includes('[') || text.includes(']'))
        throw new Error('Invalid claim text');
      const existing = byText.get(text);
      if (existing)
        existing.citationIds = [
          ...new Set([...existing.citationIds, ...claim.citationIds]),
        ];
      else
        byText.set(text, {
          text,
          citationIds: [...new Set(claim.citationIds)],
        });
    }
  }
  const claims = [...byText.values()];
  if (
    !claims.length ||
    claims.length > 12 ||
    claims.reduce((sum, claim) => sum + claim.citationIds.length, 0) > 120
  )
    throw new Error('Too many verification claims');
  return { draft, claims };
}
