# Question workspace

The browser workspace sends a question to the verified pipeline and displays returned claims, source excerpts, version/line references, and draft support coverage. It supports loading, cancellation, failure, partial-answer, and insufficient-evidence states. Questions and answers are kept only in component memory; no browser persistence or automatic query retries are used.

## Run locally

1. Configure `apps/api/.env` using `.env.example`, including PostgreSQL, Ollama, and the server-side Groq key.
2. Migrate and ingest documents following [ingestion](ingestion.md).
3. Download and check the pinned models with `npm run rerank:smoke` and `npm run verify:smoke`.
4. Set `QUERY_ENABLED=true` and run `npm run dev`.
5. Open http://localhost:5173 and ask a question.

Without `QUERY_ENABLED=true`, the UI and liveness endpoint work but questions return a configuration-unavailable response. Health reports process liveness, not provider readiness. No migrations or ingestion happen automatically at server startup.

## HTTP contract

`POST /query` on the API accepts only JSON `{"question":"..."}`, with a trimmed question of 1–2,000 characters. The browser uses `/api/query`; Vite strips the `/api` prefix. Production hosting must provide the same reverse-proxy mapping.

Responses use the shared verified-answer schema. They contain supported claim text, citation metadata, a support ratio, and verification provenance. The ratio measures supported draft statements, not truth probability. Error bodies have a sanitized `error.code` and `error.message`; question content and provider details are not logged. Query responses are not cached.

- 400: invalid JSON or question; 413: oversized body; 415: non-JSON content.
- 429: request rate limit.
- 503: answering disabled, shutting down, or busy. Busy responses include `Retry-After: 5`.
- 504: query or generation timeout; 502: provider/verification failure.

All indexed documents matching the configured embedding model are searched. There is no user-supplied source scope or authentication in this phase. Keep the default loopback binding; add authentication and retrieval authorization before exposing private documents to other users.

## Resource limits

Each server process admits one active query with no waiting queue. Models and the database pool are reused. `QUERY_TIMEOUT_MS` defaults to 120,000 (allowed 1,000–300,000). Disconnects and timeouts signal cancellation. A request that times out retains the slot until underlying work settles, preventing overlapping local inference. Native inference and some retrieval operations cannot be forcibly interrupted; hard execution deadlines still require worker isolation. Shutdown stops accepting connections and disposes resources, with a 10-second process exit limit.

The browser disables duplicate submissions, allows cancellation, and ignores stale responses. Source text is rendered as plain text, and only credential-free HTTP(S) URLs become external links. Local paths and other source identifiers remain text.

## Validation

Tests exercise request validation, sanitized failures, unavailable configuration, timeout admission, cancellation, recovery, and a complete HTTP pipeline with PostgreSQL and the actual pinned reranker/verifier. External embedding and generation providers are controlled HTTP fixtures. DOM tests cover supported/partial/fallback answers, citations, errors, and cancelled responses. Live Groq/Ollama quality remains a separate deployment validation requirement.
