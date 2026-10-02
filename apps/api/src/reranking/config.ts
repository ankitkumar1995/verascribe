import { z } from 'zod';
import { CrossEncoderReranker } from './local.js';
export function readRerankConfig(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      RERANK_ENABLED: z
        .enum(['true', 'false'])
        .default('true')
        .transform((value) => value === 'true'),
      RERANK_TOP_K: z.coerce.number().int().min(1).max(30).default(5),
      RERANK_BATCH_SIZE: z.coerce.number().int().min(1).max(16).default(4),
      RERANK_CACHE_DIR: z.string().min(1).optional(),
      RERANK_LOCAL_FILES_ONLY: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
    })
    .parse(env);
}
export function createReranker(config: ReturnType<typeof readRerankConfig>) {
  return new CrossEncoderReranker({
    batchSize: config.RERANK_BATCH_SIZE,
    localFilesOnly: config.RERANK_LOCAL_FILES_ONLY,
    ...(config.RERANK_CACHE_DIR ? { cacheDir: config.RERANK_CACHE_DIR } : {}),
  });
}
