# Local demo release

This release targets a single-user, loopback-only portfolio demo. It is not a public or multi-tenant deployment.

## Native run

1. Configure `apps/api/.env` from the example, start PostgreSQL and Ollama, and pull `nomic-embed-text`.
2. Run `npm ci`, `npm run db:migrate`, `npm run rerank:smoke`, and `npm run verify:smoke`.
3. Ingest a small representative corpus using the Markdown, PDF, or URL commands.
4. Set the server-side Groq key and run `npm run demo:doctor`. This checks database tables, the installed Ollama model, cached local models, and key presence. It does not validate the Groq key remotely or guarantee answer quality.
5. Run `npm run check` and `npm run eval:verification:check`.
6. Set `QUERY_ENABLED=true` and `SERVE_WEB=true`, then run `npm start -w @verascribe/api` after building.
7. Open http://127.0.0.1:3001. The built UI uses the same-origin `/api/query` alias; existing `/query` clients still work.

## Docker demo

Docker Desktop (or Docker Engine with Compose) must be running. Prepare both model caches on the host with the smoke commands above; Compose mounts `.local/models` read-only and disables model downloads inside the demo container.

```sh
docker compose -f compose.demo.yml up -d --build
docker compose -f compose.demo.yml exec app node apps/api/dist/migrate.js
docker compose -f compose.demo.yml exec app node apps/api/dist/doctor.js
```

The app binds host port 3001 only on 127.0.0.1; the demo database binds 54330 only on 127.0.0.1. Its development-only connection is `postgresql://verascribe:local-demo-only@127.0.0.1:54330/verascribe`. Use that URL with the host ingestion CLIs. Demo database storage is separate from the original development Compose stack.

For answering, supply `GROQ_API_KEY` and `QUERY_ENABLED=true` to Compose using shell environment variables or an ignored environment file, then recreate the app. Do not place credentials in tracked files or command-line arguments. The default image starts with answering disabled.

Ollama runs on the host and the container uses `host.docker.internal`. Ensure Ollama is reachable from the Docker network; its default loopback-only listener may need a network configuration change. Keep any broader listener restricted by the host firewall. Native execution avoids this networking step.

The image runs as a non-root user and includes compiled migration/diagnostic commands and SQL migrations. It contains the built frontend, not a development server. Image health checks and `/health`/`/api/health` report process liveness only. Diagnostics and a real question are separate checks.

## Release checks

CI runs the complete test/build checks, dependency audit, real pinned models, the committed verification regression gate, and a container smoke test for UI/API routing and non-root execution. The seed gate requires zero false accepts and at least 0.8 label accuracy and entailment recall on the committed cases. These thresholds do not calibrate the NLI model for arbitrary documents.

Shutdown stops admission, signals active work, and disposes shared resources once. Native inference retains its slot until it settles; shutdown has a 10-second process deadline. HTTP header/body receive timeouts are separate from the longer query deadline.

## Backup and recovery

Before a migration or demo-data replacement, take a PostgreSQL dump of the database and keep it outside the repository. Validate restoration into a separate disposable database before relying on the backup. Migrations verify checksums and run transactionally; do not edit applied SQL files. Roll back app code only when it remains compatible with the migrated schema.

`docker compose -f compose.demo.yml down` stops the demo while preserving its data volume. Do not add `--volumes` unless deliberately deleting demo data. Model files are reproducible from pinned revisions; source documents and database contents need their own backup.

## Remaining work

| Area                                        | Status / next action                                                                                                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core pipeline and UI                        | Implemented: ingestion, hybrid retrieval, reranking, citation generation, verification, API, source inspection.                                                                                             |
| Local release tooling                       | Packaged in this phase; run diagnostics on the intended machine.                                                                                                                                            |
| Live end-to-end acceptance                  | Still required with a real Groq key, running Ollama, and your chosen documents. Capture supported, partial, and insufficient-evidence examples and warm/cold latency.                                       |
| Quality calibration                         | Still required on a larger labeled corpus, including compound claims, numbers, negation, ambiguous questions, conflicting documents, and injection attempts. The small seed set is only a regression check. |
| Query rewriting                             | Present in the original architecture diagram but not implemented. Defer until evaluation shows it improves retrieval without changing intent.                                                               |
| Public hosting                              | Not part of the selected local release. Choose a host, configure TLS/secrets, resource limits, monitoring, backups, and restore testing before publication.                                                 |
| Accounts and private-document authorization | Not needed for the chosen single-user local demo; required before shared/private hosting. No per-user isolation exists today.                                                                               |
| OCR and richer sources                      | Not implemented: scanned/empty-page PDFs, authenticated websites, crawling, and layout-aware extraction.                                                                                                    |
| Optional product features                   | Browser uploads, document management UI, and conversation history are not part of the completed core plan.                                                                                                  |

The “near-zero hallucination” framing in the original proposal is not a measured guarantee. Current support scores measure agreement with retrieved evidence, not factual truth.
