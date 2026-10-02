import 'dotenv/config';
import { createVerifierFromEnv } from '../src/guardrails/config.js';
const { verifier } = createVerifierFromEnv();
try {
  const start = performance.now();
  await verifier.prepare();
  const loadMs = performance.now() - start;
  const results = await verifier.verify([
    {
      premise: 'The cat is sleeping on the sofa.',
      hypothesis: 'The cat is asleep.',
    },
    {
      premise: 'The cat is sleeping on the sofa.',
      hypothesis: 'There is no cat.',
    },
    {
      premise: 'The cat is sleeping on the sofa.',
      hypothesis: 'The cat is black.',
    },
  ]);
  const expected = ['entailment', 'contradiction', 'neutral'] as const;
  results.forEach((result, i) => {
    if (result.status !== 'scored') throw new Error('Unexpected unscored pair');
    const best = Object.entries(result.probabilities).sort(
      (a, b) => b[1] - a[1],
    )[0]?.[0];
    if (best !== expected[i]) throw new Error('NLI smoke check failed');
  });
  console.log(
    JSON.stringify(
      {
        model: verifier.model,
        revision: verifier.revision,
        loadMs,
        results,
        passed: true,
      },
      null,
      2,
    ),
  );
} finally {
  await verifier.dispose();
}
