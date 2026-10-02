import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
export const RERANK_REVISION = 'a09144355adeed5f58c8ed011d209bf8ee5a1fec';
export type PairScore = { score: number; truncated: boolean };
export interface PairScorer {
  readonly model: string;
  readonly revision: string;
  score(question: string, passages: string[]): Promise<PairScore[]>;
}
export interface RerankRuntime {
  score(question: string, passages: string[]): Promise<PairScore[]>;
  dispose(): Promise<void>;
}
const configSchema = z.object({
  batchSize: z.number().int().min(1).max(16).default(4),
  cacheDir: z
    .string()
    .min(1)
    .default(
      fileURLToPath(new URL('../../../../.local/models/', import.meta.url)),
    ),
  localFilesOnly: z.boolean().default(false),
});
export type RerankConfig = z.output<typeof configSchema>;
export const pairScoresSchema = z.array(
  z.object({ score: z.number().finite(), truncated: z.boolean() }),
);
const inputSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine((text) => !text.includes('\0')),
  passages: z
    .array(
      z
        .string()
        .min(1)
        .max(16000)
        .refine((text) => !text.includes('\0')),
    )
    .max(100),
});

async function loadRuntime(config: RerankConfig): Promise<RerankRuntime> {
  const { AutoTokenizer, AutoModelForSequenceClassification } =
    await import('@huggingface/transformers');
  const options = {
    revision: RERANK_REVISION,
    cache_dir: config.cacheDir,
    local_files_only: config.localFilesOnly,
  };
  const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL, options);
  const model = await AutoModelForSequenceClassification.from_pretrained(
    RERANK_MODEL,
    {
      ...options,
      dtype: 'q8',
      device: 'cpu',
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    },
  );
  return {
    async score(question, passages) {
      // Keep the query intact under longest-first pair truncation.
      if (
        tokenizer.encode(question, { add_special_tokens: false }).length > 128
      ) {
        throw new Error('Reranking questions are limited to 128 model tokens');
      }
      const truncated = passages.map(
        (passage) =>
          tokenizer.encode(question, { text_pair: passage }).length > 512,
      );
      const inputs = tokenizer(
        passages.map(() => question),
        {
          text_pair: passages,
          padding: true,
          truncation: true,
          max_length: 512,
        },
      );
      const output = await model(inputs);
      const logits = output.logits;
      if (
        logits.dims.length !== 2 ||
        logits.dims[0] !== passages.length ||
        logits.dims[1] !== 1
      ) {
        throw new Error('Expected one relevance logit per query-passage pair');
      }
      return Array.from(logits.data, (value, index) => ({
        score: Number(value),
        truncated: truncated[index]!,
      }));
    },
    async dispose() {
      await model.dispose();
    },
  };
}

export class CrossEncoderReranker implements PairScorer {
  readonly model = RERANK_MODEL;
  readonly revision = RERANK_REVISION;
  private readonly config: RerankConfig;
  private loading: Promise<RerankRuntime> | undefined;
  private busy = false;
  private closed = false;
  constructor(
    config: z.input<typeof configSchema> = {},
    private readonly loader: (
      config: RerankConfig,
    ) => Promise<RerankRuntime> = loadRuntime,
  ) {
    this.config = configSchema.parse(config);
  }

  async prepare(): Promise<void> {
    await this.runtime();
  }
  private runtime(): Promise<RerankRuntime> {
    if (this.closed) return Promise.reject(new Error('Reranker is closed'));
    this.loading ??= this.loader(this.config).catch((error) => {
      this.loading = undefined;
      throw error;
    });
    return this.loading;
  }
  async score(question: string, passages: string[]): Promise<PairScore[]> {
    const input = inputSchema.parse({ question, passages });
    if (this.closed) throw new Error('Reranker is closed');
    if (input.passages.length === 0) return [];
    // Reject concurrent work instead of accumulating an unbounded native inference queue.
    if (this.busy) throw new Error('Reranker is busy');
    this.busy = true;
    try {
      const runtime = await this.runtime();
      const scores: PairScore[] = [];
      for (
        let start = 0;
        start < input.passages.length;
        start += this.config.batchSize
      ) {
        const batch = input.passages.slice(
          start,
          start + this.config.batchSize,
        );
        const result = pairScoresSchema.parse(
          await runtime.score(input.question, batch),
        );
        if (result.length !== batch.length)
          throw new Error('Reranker score count mismatch');
        scores.push(...result);
      }
      return scores;
    } finally {
      this.busy = false;
    }
  }
  async dispose(): Promise<void> {
    if (this.busy) throw new Error('Cannot dispose a busy reranker');
    if (this.closed) return;
    this.closed = true;
    const runtime = await this.loading?.catch(() => undefined);
    if (runtime) await runtime.dispose();
    this.loading = undefined;
  }
}
