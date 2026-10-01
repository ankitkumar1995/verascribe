import type { Pool } from 'pg';
import { z } from 'zod';
import { validateVectors } from '../ingestion/embeddings.js';
import {
  rankedChunkSchema,
  retrievalRequestSchema,
  type SearchBackend,
  type SearchOptions,
} from './types.js';

const fields = `
  c.id AS "chunkId", c.document_id AS "documentId",
  d.source_key AS "sourceKey", d.source_url AS "sourceUrl", d.title, d.version,
  c.ordinal, c.content, c.metadata`;

export class PostgresSearch implements SearchBackend {
  constructor(private readonly pool: Pool) {}
  async search(vector: number[], model: string, input: SearchOptions) {
    const options = retrievalRequestSchema.parse(input);
    z.string().min(1).max(256).parse(model);
    validateVectors([vector], 1);
    if (options.sourceKeys?.length === 0) return { dense: [], sparse: [] };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(
        'SET LOCAL search_path TO verascribe, public, extensions',
      );
      await client.query("SET LOCAL statement_timeout = '5s'");
      // Exact search over a materialized, filtered set gives complete model/scope
      // filtering. Approximate HNSW can underfill filtered results at small ef_search.
      const dense = await client.query(
        `
        WITH eligible AS MATERIALIZED (
          SELECT ${fields}, c.embedding
          FROM verascribe.chunks c
          JOIN verascribe.documents d ON d.id = c.document_id
          WHERE d.embedding_model = $1
            AND ($2::text[] IS NULL OR d.source_key = ANY($2::text[]))
        )
        SELECT "chunkId", "documentId", "sourceKey", "sourceUrl", title, version,
          ordinal, content, metadata, 1 - (embedding <=> $3::vector) AS score
        FROM eligible
        ORDER BY embedding <=> $3::vector, "chunkId"
        LIMIT $4
      `,
        [
          model,
          options.sourceKeys ?? null,
          JSON.stringify(vector),
          options.candidateLimit,
        ],
      );
      const sparse = await client.query(
        `
        SELECT ${fields}, ts_rank_cd(c.tsv, q.query) AS score
        FROM verascribe.chunks c
        JOIN verascribe.documents d ON d.id = c.document_id
        CROSS JOIN websearch_to_tsquery('english', $3) AS q(query)
        WHERE d.embedding_model = $1
          AND ($2::text[] IS NULL OR d.source_key = ANY($2::text[]))
          AND c.tsv @@ q.query
          AND ts_rank_cd(c.tsv, q.query) > 0
        ORDER BY score DESC, c.id
        LIMIT $4
      `,
        [
          model,
          options.sourceKeys ?? null,
          options.question,
          options.candidateLimit,
        ],
      );
      const result = {
        dense: z.array(rankedChunkSchema).parse(dense.rows),
        sparse: z.array(rankedChunkSchema).parse(sparse.rows),
      };
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
