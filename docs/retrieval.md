# Hybrid retrieval

This feature returns evidence candidates through an admin CLI and a reusable
service. It does not generate answers or expose a public search endpoint yet.

## Usage

Start the local database and complete the [ingestion setup](ingestion.md).
Ingest at least one Markdown document with the same embedding model used for search.

```sh
npm run search -- "How are failed imports retried?"
npm run search -- "How are failed imports retried?" verascribe-readme
```

The optional arguments restrict search to source keys. The JSON response contains
chunk text, source URL/key, document ID/version, heading and line metadata,
one-based dense/sparse ranks, raw scores, and an RRF score. Treat this output as
potentially sensitive document content.

## Ranking and consistency

1. Nomic questions use the `search_query:` prefix; documents retain
   `search_document:`. The query vector must have 768 finite dimensions and be nonzero.
2. Both legs filter to the configured embedding model and optional source scope.
   Missing scope means all documents for that model; an explicit empty scope means none.
3. Dense retrieval orders by cosine distance. A materialized eligible set currently
   uses exact search to avoid approximate-index filtering gaps at this project scale.
   The existing HNSW index is reserved for a later measured optimization.
4. Sparse retrieval uses English `websearch_to_tsquery`, `tsvector`, and
   `ts_rank_cd`. This is PostgreSQL full-text ranking, not BM25. Quoted phrases,
   OR, and negation follow PostgreSQL web-search syntax.
5. Each leg returns at most 30 candidates by default. RRF sums
   `1 / (60 + rank)` and returns the best 30 distinct chunks. Limits are configurable
   up to 100; ties use chunk IDs. Raw scores are never mixed across scoring scales.
6. Both SQL queries run in one read-only repeatable-read transaction with a
   five-second timeout per statement. An update cannot mix document versions between legs.
   Provider/database errors propagate instead of being reported as empty evidence.

RRF scores are ranking signals, not confidence or evidence-support probabilities.
Dense search can return candidates for unanswerable questions. Abstention belongs
to the later verification feature. Reranking and query rewriting are deferred.
A source filter is an admin selection tool, not authorization: a future authenticated
endpoint must derive allowed sources from server-side access controls.

Changing a model under the same mutable tag cannot be detected from its name.
Use fixed model versions and re-ingest when the underlying model changes.
Full-text search is currently English; other languages need explicit configuration.

## Evaluation

`eval/retrieval.json` contains six small fictional documents and eleven labeled
questions: direct lookup, a paraphrase, ambiguity, and unanswerable questions.
It is a seed dataset, not a representative accuracy benchmark.

For a real model run, prepare a migrated disposable database, then set
`EVAL_DATABASE_URL` in `apps/api/.env` or the shell. Start Ollama and run:

```sh
npm run eval:retrieval
```

The command ingests uniquely namespaced fixture documents, restricts retrieval to
those documents, prints per-question metrics and timings, and removes its own
documents and run records on completion. It does not apply migrations automatically.
A database outage or killed process may require cleanup of `eval-` source keys.

Recall@5 is the fraction of relevant documents represented in the first five
retrieved chunks; duplicate chunks from one document receive no extra credit.
MRR@5 uses the first relevant chunk's rank. Unanswerable cases have null relevance
metrics and report candidate counts only; this is not an abstention evaluation.

CI uses controlled vectors against real pgvector to verify search and fusion
behavior. These tests do not establish semantic quality for a live embedding model.
Do not claim an accuracy target until running this dataset with a real model and
expanding it with representative user questions.

## References

- [PostgreSQL query parsing and text ranking](https://www.postgresql.org/docs/current/textsearch-controls.html)
- [pgvector exact search and filtering](https://github.com/pgvector/pgvector)
- [Nomic model task prefixes](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5)
