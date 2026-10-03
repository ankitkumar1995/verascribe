import { z } from 'zod';
import { nliResultSchema, type NliResult } from './nli.js';
export const verificationDatasetSchema = z
  .array(
    z
      .object({
        id: z.string().min(1),
        premise: z.string().min(1).max(20000),
        hypothesis: z.string().min(1).max(1500),
        label: z.enum(['entailment', 'contradiction', 'neutral']),
      })
      .strict(),
  )
  .min(1)
  .max(120)
  .refine(
    (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
    'Duplicate case ID',
  );
export function evaluateVerification(
  input: z.infer<typeof verificationDatasetSchema>,
  results: NliResult[],
  threshold: number,
) {
  const dataset = verificationDatasetSchema.parse(input);
  const scores = z.array(nliResultSchema).length(dataset.length).parse(results);
  z.number().min(0.5).max(1).parse(threshold);
  const rows = dataset.map((item, index) => {
    const result = scores[index]!;
    const predicted =
      result.status === 'scored'
        ? Object.entries(result.probabilities).sort(
            (a, b) => b[1] - a[1],
          )[0]![0]
        : 'unverifiable';
    const accepted =
      result.status === 'scored' &&
      predicted === 'entailment' &&
      result.probabilities.entailment >= threshold &&
      result.probabilities.entailment > result.probabilities.neutral &&
      result.probabilities.entailment > result.probabilities.contradiction;
    return { id: item.id, expected: item.label, predicted, accepted, result };
  });
  const positives = rows.filter((row) => row.expected === 'entailment').length;
  const accepted = rows.filter((row) => row.accepted).length;
  const trueAccepted = rows.filter(
    (row) => row.accepted && row.expected === 'entailment',
  ).length;
  const summary = {
    cases: rows.length,
    labelAccuracy:
      rows.filter((row) => row.expected === row.predicted).length / rows.length,
    acceptedPrecision: accepted ? trueAccepted / accepted : null,
    entailmentRecall: positives ? trueAccepted / positives : null,
    falseAccepted: rows
      .filter((row) => row.accepted && row.expected !== 'entailment')
      .map((row) => row.id),
  };
  // Regression gate on committed seed cases, not a general safety certification.
  const passed =
    summary.falseAccepted.length === 0 &&
    summary.labelAccuracy >= 0.8 &&
    summary.entailmentRecall !== null &&
    summary.entailmentRecall >= 0.8 &&
    new Set(dataset.map((row) => row.label)).size === 3;
  return {
    summary,
    rows,
    gate: {
      passed,
      maxFalseAccepted: 0,
      minLabelAccuracy: 0.8,
      minEntailmentRecall: 0.8,
    },
  };
}
