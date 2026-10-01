# Markdown ingestion

This feature is a local/admin CLI, not a public upload endpoint. It stores data in
a private PostgreSQL schema compatible with Supabase. Do not expose that schema
through Supabase's Data API. Never put the database URL in frontend configuration.

## Start dependencies

```sh
docker compose up -d --wait
```

Copy `apps/api/.env.example` to `apps/api/.env`.
Install Ollama separately, start it, and run `ollama pull nomic-embed-text`.
The embedding model must produce 768-dimensional vectors. Changing dimensions
requires a database migration; changing models requires re-ingestion of every document
before retrieval can safely compare vectors. Keep a fixed model version in deployments.

## Commands (repository root)

```sh
npm run db:migrate
npm run ingest -- ../../README.md verascribe-readme https://github.com/ankitkumar1995/verascribe
npm run document:delete -- verascribe-readme
```

Paths are relative to `apps/api` because npm runs the command in that workspace.
Absolute paths are also supported. Use a stable source key to update the same document
after renaming or moving a file. Omit the optional source key/URL to use its canonical file URL.

## Guarantees and limits

- Only UTF-8 Markdown up to 2 MiB and 2,000 chunks is accepted.
- An AST distinguishes headings from fenced code. Chunk metadata includes heading
  ancestry and line ranges; oversized blocks split at whitespace within a character budget.
- SHA-256 includes content, source URL, model, and chunker version. Duplicate imports
  skip embedding. Changed imports replace chunks in one transaction and increment a version.
- Concurrent imports serialize at commit. For different content on the same source,
  the last completed transaction wins; a future job queue can enforce submission order.
- Failed embedding calls preserve existing content. Failed writes roll back.
- Runs are recorded with status and generic error code; retry by rerunning the same command.
  A process killed mid-run may leave a `running` audit record; automatic job recovery is deferred.
- Ollama uses batches of 16, a 30-second request timeout, and no silent input truncation.
  Retry is explicit through the CLI; provider response bodies are not logged.
- Deleting a document cascades to its chunks; run history remains for audit.
- The local Docker password is development-only and the port binds to loopback.
- Live Ollama inference needs separate verification after the model is installed.

## Database integration tests

Set `TEST_DATABASE_URL` to a disposable pgvector database, then run `npm test`.
Tests apply migrations and create/remove uniquely keyed fixtures. Without that variable,
database integration tests are explicitly skipped. CI supplies a dedicated database.
