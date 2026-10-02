# Evidence reranking

Search now retrieves up to 30 fused candidates, scores each question/passage pair
with a local cross-encoder, and returns the best five by default. Source identity,
version, line ranges, and the original retrieval scores remain intact.

## Model and runtime

- Model: `Xenova/ms-marco-MiniLM-L-6-v2`
- Revision: `a09144355adeed5f58c8ed011d209bf8ee5a1fec`
- Runtime: `@huggingface/transformers`, CPU, quantized int8 weights.
- Two intra-op threads, one inter-op thread, batches of four.
- Downloads happen on first use; files are cached in the repository's ignored
  `.local/models/` directory. No document text is sent to the model host.
- The model is loaded once per instance and explicitly disposed by CLI commands.
  An instance rejects overlapping inference instead of accumulating a work queue.

The score is a raw relevance logit, not confidence, entailment, or a probability.
Ranking relevant passages does not verify the claims in a generated answer.

## Configuration

Place settings in `apps/api/.env` or the shell:

| Setting                   | Default                     | Behavior                                             |
| ------------------------- | --------------------------- | ---------------------------------------------------- |
| `RERANK_ENABLED`          | `true`                      | Set `false` to inspect the original retrieval order  |
| `RERANK_TOP_K`            | `5`                         | Integer from 1 to 30                                 |
| `RERANK_BATCH_SIZE`       | `4`                         | Integer from 1 to 16                                 |
| `RERANK_LOCAL_FILES_ONLY` | `false`                     | Use `true` after downloading to require cached files |
| `RERANK_CACHE_DIR`        | Repository `.local/models/` | Optional absolute cache directory                    |

```sh
npm run rerank:smoke
npm run search -- "How are failed imports retried?"
npm run eval:retrieval
```

The smoke command downloads/loads the pinned model and checks relevant-versus-
irrelevant passage ordering without requiring PostgreSQL or Ollama.
Search and evaluation still require the ingestion database and Ollama embeddings.

## Input and operational limits

- At most 100 pairs per service call; CLI retrieval currently supplies up to 30.
- Questions have the existing 2,000-character limit and an additional 128-token
  model limit. Longer tokenized questions fail rather than being silently clipped.
- Model inputs are capped at 512 tokens per pair. Long passages may be truncated
  for scoring, reported as `scoringTruncated`. Returned source text remains complete.
- Ties preserve the original retrieval order. Invalid or missing scores fail the
  call; model failures never silently substitute the unreranked candidates.
- Empty candidate lists skip model loading.
- CPU inference and downloads do not have a hard cancellation deadline in this
  in-process implementation. Before connecting a concurrent public API, isolate
  native inference in workers with deadlines and a bounded request queue.
- The model is primarily English and trained for passage relevance. Evaluate
  language/domain coverage before deployment; tiny fixtures cannot establish accuracy.

## Evaluation and verification

The evaluation command compares original and reranked top-k results using the
**same candidate pool and cutoff**. It reports recall/MRR before and after,
deltas, mean and p95 reranking time, per-case retrieval time, and separate model
load time. The first inference can include runtime warmup. Unanswerable cases
remain excluded from relevance averages; abstention is a later feature.

Default tests use controlled scorer outputs for failure paths and ordering.
Set `RUN_MODEL_TESTS=true` to also run the pinned real-model tests and enable
real reranking in CLI integration tests. CI enables these tests and caches the model.
The CLI integration fixtures use controlled embeddings and actual PostgreSQL;
their scores are plumbing checks, not live-Ollama semantic benchmarks.

Verified locally: the real CPU model ranks a Berlin population passage above an
unrelated New York passage, flags oversized scoring inputs, rejects long questions,
and runs the full evaluation command with real reranking and a test embedding server.

## References

- [Model card and pair-scoring example](https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2)
- [Transformers.js model loading](https://huggingface.co/docs/transformers.js/api/models)
