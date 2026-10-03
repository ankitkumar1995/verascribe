# Local setup without a generation key

This path prepares PostgreSQL, local embeddings, cached verification models, and a fictional sample corpus. It does not call Groq. Run commands from the repository root with Docker Desktop running, Node.js 24 and npm 11 installed.

1. Run `npm ci` and copy `apps/api/.env.example` to `apps/api/.env` if that file does not already exist. Keep `QUERY_ENABLED=false` until generation is configured. Never overwrite an existing environment file.
2. Start the database and optional CPU embedding service:

   ```sh
   docker compose --profile embeddings up -d --wait
   docker compose exec ollama ollama pull nomic-embed-text
   ```

   The embedding service binds only `127.0.0.1:11434` and stores downloaded models in a named volume. If Ollama already runs on that port, use your existing installation and start only `docker compose up -d --wait db`.

3. Prepare the database and local models:

   ```sh
   npm run db:migrate
   npm run rerank:smoke
   npm run verify:smoke
   npm run build
   ```

4. Ingest the included fictional handbook. The relative path is resolved from the API workspace:

   ```sh
   npm run ingest -- ../../examples/demo-handbook.md demo:cedar-handbook
   npm run search -- "When is Cedar Workshop open?" demo:cedar-handbook
   ```

   Search should return the Tuesday–Saturday opening hours with source metadata and reranking results. Repeating ingestion with unchanged content skips replacement. Remove only this sample with `npm run document:delete -- demo:cedar-handbook`.

5. Run `npm run demo:doctor`. With no Groq key, database, Ollama, reranker, and verifier should pass. The generation-config check intentionally fails and the command exits nonzero; this does not indicate a failure in local retrieval.
6. To preview the built interface, set `SERVE_WEB=true` in `apps/api/.env`, keep `QUERY_ENABLED=false`, and run `npm start -w @verascribe/api`. Open http://127.0.0.1:3001. Answer requests remain unavailable until configured.

When ready for answers, set `GROQ_API_KEY` locally in the ignored API environment file, set `QUERY_ENABLED=true`, and restart the API. Run a supported question (opening hours), a partly documented question (membership price and refund policy), and an undocumented question (parking availability). Inspect the actual answers and citations; these are acceptance prompts, not a guarantee about output. The local retrieval setup does not validate Groq access or end-to-end answer quality.

To stop services while preserving documents and models, run `docker compose --profile embeddings stop`. Start them again with the command above. Do not remove volumes unless intentionally deleting local data.
