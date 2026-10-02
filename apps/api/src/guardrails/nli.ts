import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const NLI_MODEL = 'Xenova/nli-deberta-v3-xsmall';
export const NLI_REVISION = '2a4f614a701367a02d51389039afc998faeda637';
export const nliPairSchema = z
  .object({
    premise: z.string().min(1).max(20000),
    hypothesis: z.string().min(1).max(1500),
  })
  .strict();
export type NliPair = z.infer<typeof nliPairSchema>;
const probabilitySchema = z
  .object({
    contradiction: z.number().min(0).max(1),
    entailment: z.number().min(0).max(1),
    neutral: z.number().min(0).max(1),
  })
  .strict()
  .refine(
    (p) => Math.abs(p.contradiction + p.entailment + p.neutral - 1) < 0.0001,
    'Invalid probability total',
  );
export const nliResultSchema = z.discriminatedUnion('status', [
  z
    .object({ status: z.literal('scored'), probabilities: probabilitySchema })
    .strict(),
  z.object({ status: z.literal('input_too_long') }).strict(),
]);
export type NliResult = z.infer<typeof nliResultSchema>;
export interface EntailmentVerifier {
  readonly model: string;
  readonly revision: string;
  verify(pairs: NliPair[]): Promise<NliResult[]>;
}
export interface NliRuntime {
  verify(pairs: NliPair[]): Promise<NliResult[]>;
  dispose(): Promise<void>;
}
const configSchema = z.object({
  batchSize: z.number().int().min(1).max(8).default(4),
  cacheDir: z
    .string()
    .min(1)
    .default(
      fileURLToPath(new URL('../../../../.local/models/', import.meta.url)),
    ),
  localFilesOnly: z.boolean().default(false),
});
export type NliConfig = z.output<typeof configSchema>;
export function probabilitiesFromLogits(values: number[]) {
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value)))
    throw new Error('Invalid NLI logits');
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return probabilitySchema.parse({
    contradiction: exps[0]! / sum,
    entailment: exps[1]! / sum,
    neutral: exps[2]! / sum,
  });
}
async function loadRuntime(config: NliConfig): Promise<NliRuntime> {
  const { AutoTokenizer, AutoModelForSequenceClassification } =
    await import('@huggingface/transformers');
  const options = {
    revision: NLI_REVISION,
    cache_dir: config.cacheDir,
    local_files_only: config.localFilesOnly,
  };
  const tokenizer = await AutoTokenizer.from_pretrained(NLI_MODEL, options);
  const model = await AutoModelForSequenceClassification.from_pretrained(
    NLI_MODEL,
    {
      ...options,
      dtype: 'q8',
      device: 'cpu',
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    },
  );
  const configLabels = z
    .object({ id2label: z.record(z.string(), z.string()) })
    .safeParse(model.config);
  const labels = configLabels.success ? configLabels.data.id2label : undefined;
  if (
    labels?.['0'] !== 'contradiction' ||
    labels?.['1'] !== 'entailment' ||
    labels?.['2'] !== 'neutral'
  ) {
    await model.dispose();
    throw new Error('Unexpected NLI label mapping');
  }
  return {
    async verify(pairs) {
      const results: NliResult[] = pairs.map(() => ({
        status: 'input_too_long',
      }));
      const eligible = pairs
        .map((pair, index) => ({ ...pair, index }))
        .filter(
          (pair) =>
            tokenizer.encode(pair.premise, { text_pair: pair.hypothesis })
              .length <= 512,
        );
      if (!eligible.length) return results;
      const inputs = tokenizer(
        eligible.map((pair) => pair.premise),
        {
          text_pair: eligible.map((pair) => pair.hypothesis),
          padding: true,
          truncation: false,
        },
      );
      const output = await model(inputs);
      const logits = output.logits;
      if (
        logits.dims.length !== 2 ||
        logits.dims[0] !== eligible.length ||
        logits.dims[1] !== 3
      )
        throw new Error('Unexpected NLI output shape');
      for (const [index, pair] of eligible.entries()) {
        results[pair.index] = {
          status: 'scored',
          probabilities: probabilitiesFromLogits(
            Array.from(logits.data.slice(index * 3, index * 3 + 3), Number),
          ),
        };
      }
      return results;
    },
    async dispose() {
      await model.dispose();
    },
  };
}
export class LocalNliVerifier implements EntailmentVerifier {
  readonly model = NLI_MODEL;
  readonly revision = NLI_REVISION;
  private readonly config: NliConfig;
  private loading: Promise<NliRuntime> | undefined;
  private busy = false;
  private closed = false;
  constructor(
    config: z.input<typeof configSchema> = {},
    private readonly loader: (
      config: NliConfig,
    ) => Promise<NliRuntime> = loadRuntime,
  ) {
    this.config = configSchema.parse(config);
  }
  private runtime() {
    if (this.closed) return Promise.reject(new Error('Verifier is closed'));
    this.loading ??= this.loader(this.config).catch((error) => {
      this.loading = undefined;
      throw error;
    });
    return this.loading;
  }
  async prepare() {
    await this.runtime();
  }
  async verify(pairs: NliPair[]): Promise<NliResult[]> {
    const input = z.array(nliPairSchema).max(120).parse(pairs);
    if (this.closed) throw new Error('Verifier is closed');
    if (!input.length) return [];
    if (this.busy) throw new Error('Verifier is busy');
    this.busy = true;
    try {
      const runtime = await this.runtime();
      const results: NliResult[] = [];
      for (
        let start = 0;
        start < input.length;
        start += this.config.batchSize
      ) {
        const batch = input.slice(start, start + this.config.batchSize);
        const result = z
          .array(nliResultSchema)
          .parse(await runtime.verify(batch));
        if (result.length !== batch.length)
          throw new Error('NLI result count mismatch');
        results.push(...result);
      }
      return results;
    } finally {
      this.busy = false;
    }
  }
  async dispose() {
    if (this.busy) throw new Error('Cannot dispose a busy verifier');
    if (this.closed) return;
    this.closed = true;
    const runtime = await this.loading?.catch(() => undefined);
    try {
      await runtime?.dispose();
    } finally {
      this.loading = undefined;
    }
  }
}
