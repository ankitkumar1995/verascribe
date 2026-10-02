# Claim verification

Run `npm run answer -- "When do reset links expire?" [source-key]` after configuring ingestion, retrieval, and Groq as described in [generation](generation.md). This CLI retrieves, reranks, drafts, and verifies before printing an answer. The existing `generate` command remains an unverified debugging tool. The [question workspace](workspace.md) exposes this pipeline through the API and browser UI.

## Evidence gate

English sentence segmentation normalizes and deduplicates draft claims. Each sentence is checked against every cited passage by the local q8 `Xenova/nli-deberta-v3-xsmall` model, pinned to revision `2a4f614a701367a02d51389039afc998faeda637`. Label mapping is validated at startup.

A sentence needs entailment of at least 0.8 from a cited passage. A contradiction from any cited passage rejects it. Inputs exceeding the model's 512-token pair limit are rejected, never silently truncated. Neutral citations are removed. Every unsupported sentence is removed, even when 90% or more of the draft is supported.

The `confidence` field is supported sentence count divided by assessed draft sentence count, not a probability of truth. At the initial minimum coverage of 0.5, supported sentences can return as a partial answer. Below that threshold, the exact insufficient-evidence fallback returns with no claims or citations. A fallback can still have nonzero draft coverage. Output includes counts, model provenance, and assessment outcomes without leaking rejected claim text.

The final answer is rebuilt only from unchanged verified sentences and supporting citations. Invalid verifier output and model failures fail closed.

## Configuration and execution

Settings in `apps/api/.env`:

- `NLI_ENTAILMENT_THRESHOLD=0.8` and `MINIMUM_SUPPORT_RATIO=0.5`, each between 0.5 and 1.
- `NLI_BATCH_SIZE=4`, from 1 to 8.
- `NLI_CACHE_DIR`, default repository `.local/models`.
- `NLI_LOCAL_FILES_ONLY=false`; set true after downloading for offline startup.

The runtime initializes lazily, refuses overlapping calls, bounds pairs and batches, and explicitly disposes model resources. Cancellation is checked around inference; in-process native inference has no hard interruption deadline. A production server must add bounded admission and worker isolation if hard deadlines are required.

## Validation and limits

`npm run verify:smoke` checks real entailment, contradiction, and neutral examples. `npm run eval:verification` runs the labeled seed cases in `eval/verification.json` and reports label accuracy, acceptance precision/recall, false accepts, and latency. Neither command needs Groq or a database. First use downloads the pinned model.

The initial local run classified all 12 seed cases correctly with no false accepts. This tiny diagnostic set does not establish production accuracy or calibrate thresholds. CI also runs real-model tests and a complete pipeline integration using PostgreSQL, the real reranker and verifier, and controlled embedding/generation HTTP responses.

Sentence units are an approximation, not exhaustive atomic proposition extraction. Compound claims require broader evaluation. Each citation is evaluated independently; facts requiring combined passages may be conservatively rejected. The English model, numeric reasoning, negation, domain language, and adversarial sources need representative evaluation before release. Entailment measures agreement with evidence, not whether that evidence is true. Live Groq and live Ollama quality still require validation with configured services.
