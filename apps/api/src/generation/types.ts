import { z } from 'zod';

export type GenerationMessage = { role: 'system' | 'user'; content: string };
export interface TextGenerator {
  readonly model: string;
  complete(
    messages: GenerationMessage[],
    signal?: AbortSignal,
  ): Promise<string>;
}
export class GenerationError extends Error {
  constructor(
    readonly code:
      | 'INVALID_OUTPUT'
      | 'PROVIDER_ERROR'
      | 'RATE_LIMITED'
      | 'TIMEOUT'
      | 'CANCELLED',
  ) {
    super(
      code === 'INVALID_OUTPUT'
        ? 'The generator returned an invalid draft.'
        : code === 'RATE_LIMITED'
          ? 'The generation provider is rate limited.'
          : code === 'TIMEOUT'
            ? 'Generation timed out.'
            : code === 'CANCELLED'
              ? 'Generation was cancelled.'
              : 'The generation provider failed.',
    );
    this.name = 'GenerationError';
  }
}
const claimSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(1500)
      .refine(
        (text) =>
          !text.includes('[') &&
          !text.includes(']') &&
          !Array.from(text).some(
            (char) =>
              char.charCodeAt(0) < 32 ||
              [127, 8232, 8233].includes(char.charCodeAt(0)),
          ),
        'Use one plain-text sentence without citation markers',
      ),
    citations: z
      .array(z.number().int().positive())
      .min(1)
      .max(10)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate citation'),
  })
  .strict();
export const generatedOutputSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('answer'),
      claims: z.array(claimSchema).min(1).max(12),
    })
    .strict(),
  z
    .object({ status: z.literal('insufficient_evidence'), claims: z.tuple([]) })
    .strict(),
]);
