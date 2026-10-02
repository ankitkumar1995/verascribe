import { z } from 'zod';
import {
  GenerationError,
  type GenerationMessage,
  type TextGenerator,
} from './types.js';

const configSchema = z.object({
  apiKey: z.string().trim().min(1),
  model: z.string().trim().min(1).max(200).default('llama-3.3-70b-versatile'),
  timeoutMs: z.number().int().min(1).max(120000).default(30000),
});
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.literal('stop'),
        message: z.object({ content: z.string().min(1).max(24000) }),
      }),
    )
    .length(1),
});
async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new GenerationError('INVALID_OUTPUT');
  const reader = response.body.getReader();
  const pieces: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) throw new GenerationError('INVALID_OUTPUT');
      pieces.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(pieces).toString('utf8')) as unknown;
}
export class GroqGenerator implements TextGenerator {
  readonly model: string;
  private readonly config: z.output<typeof configSchema>;
  constructor(
    config: z.input<typeof configSchema>,
    private readonly request: typeof fetch = fetch,
  ) {
    this.config = configSchema.parse(config);
    this.model = this.config.model;
  }
  async complete(
    messages: GenerationMessage[],
    signal?: AbortSignal,
  ): Promise<string> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      combined.throwIfAborted();
      const response = await this.request(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: 'Bearer ' + this.config.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature: 0,
            max_completion_tokens: 1500,
            response_format: { type: 'json_object' },
            stream: false,
          }),
          signal: combined,
        },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new GenerationError(
          response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
        );
      }
      const data = responseSchema.safeParse(await readBoundedJson(response));
      if (!data.success) throw new GenerationError('INVALID_OUTPUT');
      return data.data.choices[0]!.message.content;
    } catch (error) {
      if (signal?.aborted) throw new GenerationError('CANCELLED');
      if (timeout.aborted) throw new GenerationError('TIMEOUT');
      if (error instanceof GenerationError) throw error;
      if (error instanceof SyntaxError)
        throw new GenerationError('INVALID_OUTPUT');
      throw new GenerationError('PROVIDER_ERROR');
    }
  }
}
