# Citation-Backed Q&A with Hallucination Guardrails

### Complete build plan — $0 cost, your stack (Node.js/Express/TypeScript/LangChain)

---

## 1. What this project proves

This is the "production-grade RAG" tier — it goes beyond basic retrieval and adds the two things that separate a toy demo from something you'd actually trust:

1. **Every claim in the answer is traceable to a source chunk** (citation-backed generation)
2. **The system knows when it doesn't know** — confidence scoring + an entailment check that catches hallucinated claims *before* they reach the user

This maps directly to the near-zero-hallucination design you worked through earlier, scaled down to something buildable solo, for free, in a few weeks.

---

## 2. Full free stack

| Layer | Tool | Why |
| --- | --- | --- |
| LLM (generation) | **Groq** (free tier) — Llama 3.1 70B or Gemini 1.5 Flash (free tier) | Fast, free, good enough reasoning for entailment-style checks |
| Embeddings | **Gemini embedding API** (free tier) or **Ollama** `nomic-embed-text` (local, unlimited, free) | Gemini free tier is generous; Ollama is zero rate-limit if you don't mind local |
| Vector DB + metadata | **Supabase Postgres + pgvector** (free tier: 500MB) | SQL + vectors in one place, generous free tier, you already know Postgres patterns |
| Full-text search (BM25 leg) | Postgres `tsvector` (built into Supabase) | No extra service |
| Entailment / NLI check | **Local cross-encoder via `@xenova/transformers`** (`cross-encoder/nli-deberta-v3-base` ONNX) OR a second Groq LLM call with a strict yes/no prompt | Transformers.js runs in Node, zero cost, zero API calls for this step |
| Reranker | `@xenova/transformers` (`ms-marco-MiniLM-L-6-v2`) | Local, free, fast enough for small top-k |
| App hosting | **Render** or **Railway** free tier | Sleeps on idle, fine for a portfolio/demo app |
| Frontend | React (you already use React Query) | Deploy on **Vercel free tier** |

Nothing here needs a credit card.

---

## 3. Architecture

```
                         INGESTION (offline)
Docs/PDF/URLs → Loader → Chunker (semantic) → Embed (Gemini/Ollama) → Supabase pgvector

                         QUERY (online)
User question
   → Query rewrite (Groq, cheap call)
   → Hybrid retrieve: pgvector (dense) + tsvector (BM25) → RRF fusion
   → Rerank (local cross-encoder, top-30 → top-5)
   → Generate answer WITH forced inline citations (Groq, strict prompt)
   → Guardrail stage:
         a. Claim extraction (split answer into atomic claims)
         b. Entailment check: does the cited chunk actually support each claim? (local NLI model)
         c. Confidence score = % claims entailed
         d. If confidence < threshold → either strip unsupported claim, regenerate, or respond "I don't have enough information"
   → Return: answer + citations[] + confidence score
```

The guardrail stage is the heart of this project — it's what makes it "production-grade" rather than "basic RAG with citations tacked on."

---

## 4. Step-by-step build plan

### Stage 1 — Ingestion pipeline (Week 1)

- Node.js script: load docs (start with 1 source — markdown files or PDFs — then expand)
- Semantic chunking by heading/section (not fixed-size)
- Embed via Ollama (`nomic-embed-text`) locally during dev — free, no rate limit, good for iterating fast
- Store in Supabase: `chunks(id, content, embedding vector(768), metadata jsonb, source_url, tsv tsvector)`
- Add a `GENERATED ALWAYS AS (to_tsvector('english', content)) STORED` column for the BM25 leg — one SQL line, no extra service

### Stage 2 — Hybrid retrieval (Week 1–2)

- Dense: `embedding <=> query_embedding` cosine distance query in pgvector
- Sparse: Postgres `ts_rank` against the `tsv` column
- Fuse with **Reciprocal Rank Fusion** (simple formula, no library needed — a few lines of TS)
- Retrieve top-30 candidates → pass to reranker

### Stage 3 — Reranking (Week 2)

- `@xenova/transformers` cross-encoder, runs in-process in Node, no API call
- Score query-chunk pairs, keep top-5
- This is the single highest-ROI accuracy step — budget real time tuning it

### Stage 4 — Citation-forced generation (Week 2–3)

- System prompt pattern (this is the key engineering artifact of the whole project):

```
You must answer ONLY using the numbered context chunks below.
For every factual sentence, append the chunk number(s) it came from, like [1][3].
If the context does not contain enough information, say exactly:
"I don't have enough information to answer that."
Do not use outside knowledge. Do not combine information in ways not stated in the chunks.

Context:
[1] {chunk_1}
[2] {chunk_2}
...

Question: {query}
```

- Call via Groq (Llama 3.1) — fast and free-tier friendly
- Parse the `[n]` citation markers out of the response programmatically, map back to chunk → source URL

### Stage 5 — Guardrail / entailment layer (Week 3) — the differentiator

This is what most portfolio RAG projects skip, and exactly what you called out wanting to demonstrate.

1. **Claim splitting**: split the generated answer into sentences (simple, or a cheap LLM call for atomic claims)
2. **Entailment check**: for each claim + its cited chunk, run through a local NLI model (`entailment` / `neutral` / `contradiction`). `@xenova/transformers` ships ONNX NLI models that run fine on CPU for short text pairs.
3. **Confidence score** = (entailed claims) / (total claims)
4. **Decision logic**:
   - confidence ≥ 0.9 → return as-is
   - 0.5–0.9 → strip unsupported sentences, return the rest with a note
   - \< 0.5 → return the "I don't have enough information" fallback instead of the generated answer

This closed loop (generate → verify → gate) is the exact mechanism from your bigger 10M-doc design, just running on local free models instead of a hosted verification service.

### Stage 6 — API + frontend (Week 4)

- Express endpoint: `POST /query` → `{ answer, citations: [{text, sourceUrl, chunkId}], confidence }`
- React frontend (React Query for the fetch/cache) — show answer, inline citation chips, and a confidence badge
- Deploy: Render (API) + Vercel (frontend), Supabase already hosted

---

## 5. Folder structure

```
citation-rag/
├── src/
│   ├── ingestion/
│   │   ├── loaders/          # markdown, pdf, url loaders
│   │   ├── chunker.ts
│   │   └── embed.ts
│   ├── retrieval/
│   │   ├── dense.ts           # pgvector query
│   │   ├── sparse.ts          # tsvector query
│   │   ├── fusion.ts          # RRF
│   │   └── rerank.ts          # xenova cross-encoder
│   ├── generation/
│   │   ├── prompt.ts
│   │   └── groqClient.ts
│   ├── guardrails/
│   │   ├── claimSplit.ts
│   │   ├── entailment.ts      # xenova NLI model
│   │   └── confidence.ts
│   ├── db/
│   │   └── supabaseClient.ts
│   └── routes/
│       └── query.ts
├── scripts/
│   └── ingest.ts              # run manually or via cron
└── docker-compose.yml         # optional local Postgres+pgvector for dev
```

---

## 6. Honest limits (say these in an interview — shows judgment)

- Free-tier Groq/Gemini rate limits mean this won't handle real concurrent load — fine for a demo
- Local NLI/reranker models on CPU add latency (expect 1-3s extra per query) — in a real system these would be hosted/batched
- Render/Vercel free tiers cold-start — acceptable for portfolio, not for an SLA
- Entailment checking at claim-level is a simplified version of what production hallucination-detection systems do (which often use ensembles or fine-tuned verifiers) — worth saying explicitly that you know this is the "demonstrates the concept" version, not the "handles every edge case" version

---

## 7. What to say about this project in an interview

Frame it as: *"I built a RAG system where the generation step is gated by an automated entailment check — the model has to prove each claim is supported by the retrieved context before the answer is returned, with a confidence score and a graceful fallback when it can't verify itself."* That one sentence demonstrates you understand RAG failure modes, not just RAG happy-path.