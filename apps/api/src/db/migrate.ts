import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

export async function migrate(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SET LOCAL search_path TO verascribe, public, extensions',
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('verascribe:migrations', 0))",
    );
    await client.query('CREATE SCHEMA IF NOT EXISTS verascribe');
    await client.query('REVOKE ALL ON SCHEMA verascribe FROM PUBLIC');
    await client.query(
      'CREATE TABLE IF NOT EXISTS verascribe.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL)',
    );
    const directory = new URL('./migrations/', import.meta.url);
    const files = (await readdir(directory))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const name of files) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = await client.query<{ checksum: string }>(
        'SELECT checksum FROM verascribe.schema_migrations WHERE name = $1',
        [name],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].checksum !== checksum)
          throw new Error('Applied migration was modified: ' + name);
        continue;
      }
      await client.query(sql);
      await client.query(
        'INSERT INTO verascribe.schema_migrations(name, checksum) VALUES ($1, $2)',
        [name, checksum],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
