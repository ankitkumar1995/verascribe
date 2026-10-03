import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createVerifierFromEnv } from '../src/guardrails/config.js';
import {
  evaluateVerification,
  verificationDatasetSchema,
} from '../src/guardrails/evaluation.js';
async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check'))
    throw new Error('Invalid arguments');
  const dataset = verificationDatasetSchema.parse(
    JSON.parse(
      await readFile(
        new URL('../../../eval/verification.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  const { verifier, policy } = createVerifierFromEnv();
  try {
    const loadStart = performance.now();
    await verifier.prepare();
    const loadMs = performance.now() - loadStart;
    const start = performance.now();
    const results = await verifier.verify(
      dataset.map(({ premise, hypothesis }) => ({ premise, hypothesis })),
    );
    const elapsedMs = performance.now() - start;
    const report = evaluateVerification(
      dataset,
      results,
      policy.entailmentThreshold,
    );
    console.log(
      JSON.stringify(
        {
          model: verifier.model,
          revision: verifier.revision,
          policy,
          loadMs,
          elapsedMs,
          ...report,
          note: 'Seed regression gate only. Domain calibration and live end-to-end quality remain separate release checks.',
        },
        null,
        2,
      ),
    );
    if (args.includes('--check') && !report.gate.passed) process.exitCode = 1;
  } finally {
    await verifier.dispose();
  }
}
main().catch(() => {
  console.error(
    'Verification evaluation failed. Check the dataset, model cache and settings.',
  );
  process.exitCode = 1;
});
