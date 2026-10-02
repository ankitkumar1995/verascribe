import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createVerifierFromEnv } from '../src/guardrails/config.js';

const dataset = z
  .array(
    z.object({
      id: z.string(),
      premise: z.string(),
      hypothesis: z.string(),
      label: z.enum(['entailment', 'contradiction', 'neutral']),
    }),
  )
  .parse(
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
  const rows = dataset.map((item, index) => {
    const result = results[index]!;
    const predicted =
      result.status === 'scored'
        ? Object.entries(result.probabilities).sort(
            (a, b) => b[1] - a[1],
          )[0]![0]
        : 'unverifiable';
    const accepted =
      result.status === 'scored' &&
      predicted === 'entailment' &&
      result.probabilities.entailment >= policy.entailmentThreshold;
    return { id: item.id, expected: item.label, predicted, accepted, result };
  });
  const trueAccepted = rows.filter(
    (row) => row.accepted && row.expected === 'entailment',
  ).length;
  const accepted = rows.filter((row) => row.accepted).length;
  const positives = rows.filter((row) => row.expected === 'entailment').length;
  console.log(
    JSON.stringify(
      {
        model: verifier.model,
        revision: verifier.revision,
        policy,
        loadMs,
        elapsedMs,
        summary: {
          cases: rows.length,
          labelAccuracy:
            rows.filter((row) => row.predicted === row.expected).length /
            rows.length,
          acceptedPrecision: accepted ? trueAccepted / accepted : null,
          entailmentRecall: positives ? trueAccepted / positives : null,
          falseAccepted: rows
            .filter((row) => row.accepted && row.expected !== 'entailment')
            .map((row) => row.id),
        },
        note: 'Small diagnostic set, not a calibrated confidence estimate or a production safety guarantee.',
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  await verifier.dispose();
}
