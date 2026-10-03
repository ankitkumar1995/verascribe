import 'dotenv/config';
import { Pool } from 'pg';
import { z } from 'zod';
import { migrate } from '../src/db/migrate.js';
async function main() {
  const databaseUrl = z.string().url().parse(process.env.DATABASE_URL);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
  });
  try {
    await migrate(pool);
    console.log('Migrations applied.');
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    'Migration failed. Check database access and migration integrity.',
  );
  process.exitCode = 1;
});
