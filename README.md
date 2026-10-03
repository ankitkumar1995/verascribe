# VeraScribe

Document Q&A with traceable citations and claim-level evidence verification.

## Local development

Requires Node.js 24 LTS and npm 11. From the repository root:

```sh
npm ci
npm run dev
```

Open http://localhost:5173. The API listens on http://127.0.0.1:3001.
The frontend proxies `/api` to the backend during development.
Optional API settings go in `apps/api/.env`; copy `apps/api/.env.example`.
No provider accounts are needed for the foundation or unit tests.

```sh
npm run check
```

Runs type checks, lint, formatting checks, tests, and production builds.
The production API runs with `npm start -w @verascribe/api` after building.
Serve the web build behind a same-origin reverse proxy for `/api` in production.

## Layout

- `apps/api`: Express API and ingestion pipeline.
- `apps/web`: React and React Query application.
- `packages/contracts`: shared runtime schemas and TypeScript contracts.
- `docs/roadmap.md`: feature order, branch names, and acceptance criteria.

## Working agreement

Use one branch per feature and keep commits scoped. Dependent branches may be
stacked locally; pull requests target main and identify any unmerged dependencies.
Do not commit credentials, private source documents, or generated model files.
Run `npm run check` before opening a pull request. Main remains the reviewed baseline.

The question workspace displays verified answers and traceable source context.
See [workspace setup](docs/workspace.md) to enable answering. Evidence support measures
draft claim coverage, not a probability of truth.

## Technical references

- [Vite setup](https://vite.dev/guide/)
- [Express 5](https://expressjs.com/en/guide/migrating-5/)
- [Ollama embeddings](https://docs.ollama.com/api/embed)

## Markdown ingestion

The ingestion CLI is implemented. See [setup, commands, and limits](docs/ingestion.md).

## Hybrid retrieval

Search indexed documents with vector and full-text ranking. See [commands and evaluation](docs/retrieval.md).

## Evidence reranking

Search now selects the best five passages using a local cross-encoder. See [model setup, configuration, and comparison metrics](docs/reranking.md).

## Citation-backed drafts

Generate answers with validated source references using the [draft generation CLI](docs/generation.md). This debugging command returns unverified drafts. Use the [verified answer CLI](docs/guardrails.md) for answers filtered against cited evidence.

## PDF and web sources

Import PDFs with page references or public HTTPS pages using the [additional source commands](docs/additional-sources.md).

## Local demo release

See [release setup and remaining work](docs/release.md) for native/Docker packaging, diagnostics, and the final acceptance checklist. This release targets local use.

For a reproducible setup without a generation key, follow [local setup and sample retrieval](docs/local-setup.md).
