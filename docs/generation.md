# Citation-backed draft generation

This stage composes retrieval, local reranking, and Groq generation. It is available
through an administrator CLI and reusable services. The public query endpoint
and final user interface remain scheduled after claim verification.

## Run

Complete the database, Ollama, and reranker setup first. Add your server-side
`GROQ_API_KEY` to `apps/api/.env`, then run:

```sh
npm run generate -- "When do password reset links expire?"
npm run generate -- "When do password reset links expire?" account-guide
```

The optional source keys restrict retrieval. Generation uses the five best
reranked passages even if baseline search has reranking disabled.
The command sends the question and selected passage text to Groq; API keys stay
server-side. It does not send database credentials or source URL metadata.

`GROQ_MODEL` defaults to `llama-3.3-70b-versatile` and can be changed to a Groq
chat model supporting JSON-object mode. Availability and quotas depend on the
provider/account. `GENERATION_TIMEOUT_MS` defaults to 30,000 (maximum 120,000).

## Output and trust boundary

The model returns structured single-sentence claims with numeric source references.
The application validates the structure and references, then renders inline
markers such as `[1][3]`. Citation URLs, chunk/document IDs, versions, excerpts,
and line metadata come exclusively from retrieved database records.

Successful generation returns `status: "draft"` and `verification: "pending"`.
It contains no confidence score. A valid citation ID does **not** establish that
the cited passage entails a claim. The later claim-verification stage must inspect
these drafts before a public answer endpoint treats them as supported.

Empty context or an explicit model refusal returns exactly
`I don't have enough information to answer that.`, with no claims/citations.
Malformed output, invalid references, provider errors, and timeouts are errors,
not claims that the knowledge base lacks an answer.

## Controls and limits

- System instructions treat both source text and the question as untrusted data.
  Evidence is JSON-encoded in a separate user message; document text never enters
  the system prompt. This reduces prompt confusion but is not a semantic injection
  defense or a substitute for claim verification.
- Default context: at most five complete chunks within 12,000 serialized characters.
  Oversized chunks are omitted, not silently truncated and cited as if fully read.
- The provider uses JSON-object mode, not a provider-enforced JSON schema.
  Strict local schemas reject unexpected fields, unknown/duplicate citation IDs,
  empty claims, fabricated inline markers, and multi-sentence claim entries.
- Sentence checks use English sentence segmentation and may reject unusual
  abbreviations. Atomic-claim extraction and entailment checking are separate work.
- Output is limited to 12 claims, 1,500 characters per claim, 1,500 completion
  tokens, and a 64 KiB provider response. Non-completed responses are rejected.
- A fixed HTTPS endpoint, rejected redirects, and sanitized errors prevent
  accidental credential disclosure via provider URLs or logged response bodies.
- Cancellation and a request/body timeout are supported. The Groq timeout does
  not cover earlier embedding or local reranking; their limits remain separate.
- No automatic generation retries: caller retries are explicit and may incur
  another provider request.
- Treat returned strings as text in future UI rendering. Do not render raw HTML.
- Source filters remain admin selections, not user authorization.

## Verification

Tests cover source mapping, context budgeting, hostile document instructions,
invalid citations, malformed/truncated responses, cancellation, HTTP errors,
and a stalled response body. Integration tests use real PostgreSQL and (when
`RUN_MODEL_TESTS=true`) the actual pinned reranker, with controlled embedding
and generation HTTP servers. No live Groq request is required by tests or CI.

Live Groq answer quality and the full live-Ollama pipeline still require validation
with configured credentials. Structural tests do not measure hallucination rates.

## References

- [Groq chat API](https://console.groq.com/docs/api-reference)
- [Groq JSON-object mode](https://console.groq.com/docs/structured-outputs)
