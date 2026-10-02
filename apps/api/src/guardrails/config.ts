import { z } from 'zod';
import { LocalNliVerifier } from './nli.js';
export function createVerifierFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const config = z
    .object({
      NLI_BATCH_SIZE: z.coerce.number().int().min(1).max(8).default(4),
      NLI_LOCAL_FILES_ONLY: z.enum(['true', 'false']).default('false'),
      NLI_CACHE_DIR: z.string().min(1).optional(),
      NLI_ENTAILMENT_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.8),
      MINIMUM_SUPPORT_RATIO: z.coerce.number().min(0.5).max(1).default(0.5),
    })
    .parse(env);
  return {
    verifier: new LocalNliVerifier({
      batchSize: config.NLI_BATCH_SIZE,
      localFilesOnly: config.NLI_LOCAL_FILES_ONLY === 'true',
      ...(config.NLI_CACHE_DIR ? { cacheDir: config.NLI_CACHE_DIR } : {}),
    }),
    policy: {
      entailmentThreshold: config.NLI_ENTAILMENT_THRESHOLD,
      minimumSupportRatio: config.MINIMUM_SUPPORT_RATIO,
    },
  };
}
