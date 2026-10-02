# Development roadmap

| Phase               | Branch                     | Acceptance criteria                                                 | Status      |
| ------------------- | -------------------------- | ------------------------------------------------------------------- | ----------- |
| Foundation          | `chore/project-foundation` | Workspaces, contracts, health API, React shell, CI                  | Implemented |
| Markdown ingestion  | `feat/markdown-ingestion`  | Semantic chunks, Ollama, migrations, atomic replace/delete, tests   | Implemented |
| Hybrid retrieval    | `feat/hybrid-retrieval`    | Vector + full-text, RRF, evaluation dataset                         | Implemented |
| Reranking           | `feat/evidence-reranking`  | Cross-encoder adapter, top-k, latency and recall comparison         | Implemented |
| Citation generation | `feat/citation-generation` | Provider adapter, context-only prompt, validated markers            | Implemented |
| Claim verification  | `feat/claim-verification`  | Sentence claims, local NLI, fail-closed gate, seed evaluation       | Implemented |
| Question workspace  | `feat/question-workspace`  | Query endpoint, accessible UI, sources, support indicator           | Implemented |
| PDF and URLs        | `feat/additional-sources`  | Page citations, parsing limits, safe URL fetching                   | Implemented |
| Release hardening   | `feat/release-hardening`   | Evaluation, deployment, provider failures, authorization if private | Planned     |

## Design rules

- Validate input, provider responses, and configuration at boundaries.
- Keep credentials server-side; avoid logging document content or questions.
- Preserve source identity and chunk ordering; replace document versions atomically.
- Use parameterized SQL, migrations, rollback, and bounded provider calls.
- Treat document instructions as untrusted data.
- Evaluate retrieval and guardrail quality using labeled questions.
- PostgreSQL full-text ranking is not BM25.
- Verify model availability and hosting limits before release.
- Add authentication and retrieval authorization before exposing private documents.
  Claim verification uses sentence units and initial thresholds. Domain calibration and broader compound-claim evaluation remain release-hardening requirements.
