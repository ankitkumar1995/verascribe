CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS verascribe;
-- Private schema: do not add it to Supabase's exposed API schemas.
REVOKE ALL ON SCHEMA verascribe FROM PUBLIC;
CREATE TABLE verascribe.documents (
  id uuid PRIMARY KEY,
  source_key text NOT NULL UNIQUE,
  source_url text NOT NULL,
  title text NOT NULL,
  fingerprint text NOT NULL,
  embedding_model text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE verascribe.chunks (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES verascribe.documents(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  content text NOT NULL CHECK (length(content) > 0),
  metadata jsonb NOT NULL,
  embedding vector(768) NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE(document_id, ordinal)
);
CREATE INDEX chunks_tsv_idx ON verascribe.chunks USING gin(tsv);
CREATE INDEX chunks_embedding_idx ON verascribe.chunks USING hnsw(embedding vector_cosine_ops);
CREATE TABLE verascribe.ingestion_runs (
  id uuid PRIMARY KEY,
  source_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'skipped', 'failed')),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
