import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { TextChunk } from './chunker.js';
import { validateVectors } from './embeddings.js';

export type DocumentWrite = {
  sourceKey: string;
  sourceUrl: string;
  title: string;
  fingerprint: string;
  model: string;
  chunks: TextChunk[];
  vectors: number[][];
};
export type WriteResult = {
  documentId: string;
  version: number;
  chunks: number;
  status: 'succeeded' | 'skipped';
};
export class DocumentStore {
  constructor(private readonly pool: Pool) {}
  async find(sourceKey: string) {
    const result = await this.pool.query<{
      id: string;
      fingerprint: string;
      version: number;
      chunks: number;
    }>(
      'SELECT d.id, d.fingerprint, d.version, (SELECT count(*)::int FROM verascribe.chunks c WHERE c.document_id=d.id) AS chunks FROM verascribe.documents d WHERE source_key=$1',
      [sourceKey],
    );
    return result.rows[0];
  }
  async startRun(sourceKey: string) {
    const id = randomUUID();
    await this.pool.query(
      "INSERT INTO verascribe.ingestion_runs(id, source_key, status) VALUES ($1, $2, 'running')",
      [id, sourceKey],
    );
    return id;
  }
  async finishRun(id: string, status: 'succeeded' | 'skipped' | 'failed') {
    await this.pool.query(
      'UPDATE verascribe.ingestion_runs SET status=$2, error_code=$3, finished_at=now() WHERE id=$1',
      [id, status, status === 'failed' ? 'INGESTION_FAILED' : null],
    );
  }
  async replace(input: DocumentWrite): Promise<WriteResult> {
    if (input.chunks.length === 0)
      throw new Error('Cannot store an empty document');
    validateVectors(input.vectors, input.chunks.length);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SET LOCAL search_path TO verascribe, public, extensions',
      );
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [input.sourceKey],
      );
      const existing = await client.query<{
        id: string;
        fingerprint: string;
        version: number;
      }>(
        'SELECT id, fingerprint, version FROM verascribe.documents WHERE source_key=$1 FOR UPDATE',
        [input.sourceKey],
      );
      const prior = existing.rows[0];
      if (prior?.fingerprint === input.fingerprint) {
        await client.query('COMMIT');
        return {
          documentId: prior.id,
          version: prior.version,
          chunks: input.chunks.length,
          status: 'skipped',
        };
      }
      const id = prior?.id ?? randomUUID();
      const version = (prior?.version ?? 0) + 1;
      await client.query(
        'INSERT INTO verascribe.documents(id, source_key, source_url, title, fingerprint, embedding_model, version) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (source_key) DO UPDATE SET source_url=excluded.source_url, title=excluded.title, fingerprint=excluded.fingerprint, embedding_model=excluded.embedding_model, version=excluded.version, updated_at=now()',
        [
          id,
          input.sourceKey,
          input.sourceUrl,
          input.title,
          input.fingerprint,
          input.model,
          version,
        ],
      );
      await client.query('DELETE FROM verascribe.chunks WHERE document_id=$1', [
        id,
      ]);
      for (const [ordinal, chunk] of input.chunks.entries()) {
        await client.query(
          'INSERT INTO verascribe.chunks(id, document_id, ordinal, content, metadata, embedding) VALUES ($1,$2,$3,$4,$5,$6::vector)',
          [
            randomUUID(),
            id,
            ordinal,
            chunk.content,
            JSON.stringify(chunk.metadata),
            JSON.stringify(input.vectors[ordinal]),
          ],
        );
      }
      await client.query('COMMIT');
      return {
        documentId: id,
        version,
        chunks: input.chunks.length,
        status: 'succeeded',
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async delete(sourceKey: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SET LOCAL search_path TO verascribe, public, extensions',
      );
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [sourceKey],
      );
      const result = await client.query(
        'DELETE FROM verascribe.documents WHERE source_key=$1',
        [sourceKey],
      );
      await client.query('COMMIT');
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
