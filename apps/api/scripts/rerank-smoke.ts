import 'dotenv/config';
import { createReranker, readRerankConfig } from '../src/reranking/config.js';

const reranker = createReranker(readRerankConfig());
try {
  const start = performance.now();
  await reranker.prepare();
  const loadMs = performance.now() - start;
  const inferenceStart = performance.now();
  const scores = await reranker.score('How many people live in Berlin?', [
    'New York City is famous for the Metropolitan Museum of Art.',
    'Berlin has a population of 3,520,031 registered inhabitants.',
  ]);
  if (!(scores[1]!.score > scores[0]!.score))
    throw new Error('Relevant passage did not rank first');
  console.log(
    JSON.stringify(
      {
        model: reranker.model,
        revision: reranker.revision,
        loadMs,
        inferenceMs: performance.now() - inferenceStart,
        scores,
        passed: true,
      },
      null,
      2,
    ),
  );
} finally {
  await reranker.dispose();
}
