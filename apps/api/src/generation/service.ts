import {
  FALLBACK_ANSWER,
  draftAnswerSchema,
  type DraftAnswer,
} from '@verascribe/contracts';
import type { SourceChunk } from '../retrieval/types.js';
import { buildGenerationPrompt, type ContextOptions } from './prompt.js';
import {
  generatedOutputSchema,
  GenerationError,
  type TextGenerator,
} from './types.js';

const insufficient = (): DraftAnswer => ({
  status: 'insufficient_evidence',
  verification: 'not_applicable',
  answer: FALLBACK_ANSWER,
  claims: [],
  citations: [],
});
export async function generateDraft(
  question: string,
  candidates: SourceChunk[],
  generator: TextGenerator,
  options: ContextOptions = {},
  signal?: AbortSignal,
): Promise<DraftAnswer> {
  if (signal?.aborted) throw new GenerationError('CANCELLED');
  const { messages, context } = buildGenerationPrompt(
    question,
    candidates,
    options,
  );
  if (context.length === 0) return insufficient();
  const raw = await generator.complete(messages, signal);
  if (signal?.aborted) throw new GenerationError('CANCELLED');
  if (raw.length > 24000) throw new GenerationError('INVALID_OUTPUT');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new GenerationError('INVALID_OUTPUT');
  }
  const checked = generatedOutputSchema.safeParse(parsed);
  if (!checked.success) throw new GenerationError('INVALID_OUTPUT');
  if (checked.data.status === 'insufficient_evidence') return insufficient();
  const contextByNumber = new Map(
    context.map((item) => [item.number, item.source]),
  );
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const used = new Set<number>();
  for (const claim of checked.data.claims) {
    if (
      [...segmenter.segment(claim.text)].filter((item) => item.segment.trim())
        .length !== 1
    ) {
      throw new GenerationError('INVALID_OUTPUT');
    }
    for (const number of claim.citations) {
      if (!contextByNumber.has(number))
        throw new GenerationError('INVALID_OUTPUT');
      used.add(number);
    }
  }
  const claims = checked.data.claims.map((claim) => ({
    text: claim.text,
    citationIds: claim.citations,
  }));
  const citations = [...used]
    .sort((a, b) => a - b)
    .map((id) => {
      const source = contextByNumber.get(id)!;
      return {
        id,
        text: source.content,
        sourceUrl: source.sourceUrl,
        chunkId: source.chunkId,
        documentId: source.documentId,
        title: source.title,
        version: source.version,
        metadata: source.metadata,
      };
    });
  return draftAnswerSchema.parse({
    status: 'draft',
    verification: 'pending',
    answer: claims
      .map(
        (claim) =>
          claim.text +
          ' ' +
          claim.citationIds.map((id) => '[' + id + ']').join(''),
      )
      .join('\n'),
    claims,
    citations,
  });
}
