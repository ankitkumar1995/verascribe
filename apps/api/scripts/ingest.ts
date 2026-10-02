import 'dotenv/config';
import { open, realpath } from 'node:fs/promises';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { z } from 'zod';
import { migrate } from '../src/db/migrate.js';
import { OllamaEmbedder } from '../src/ingestion/embeddings.js';
import { DocumentStore } from '../src/ingestion/store.js';
import { ingestMarkdown } from '../src/ingestion/service.js';

async function main() {
  const [command, argument, sourceKey, sourceUrl] = process.argv.slice(2);
  if (!['migrate', 'ingest', 'delete'].includes(command ?? ''))
    throw new Error(
      'Usage: db:migrate | ingest -- <markdown-path> [source-key] [source-url] | document:delete -- <source-key>',
    );
  const config = z
    .object({
      DATABASE_URL: z.string().url(),
      OLLAMA_URL: z.string().url().default('http://127.0.0.1:11434'),
      EMBEDDING_MODEL: z.string().min(1).default('nomic-embed-text'),
    })
    .parse(process.env);
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
  });
  try {
    const store = new DocumentStore(pool);
    if (command === 'migrate') {
      await migrate(pool);
      console.log('Migrations applied.');
      return;
    }
    if (!argument) throw new Error('Missing source path or key');
    if (command === 'delete') {
      console.log(JSON.stringify({ deleted: await store.delete(argument) }));
      return;
    }
    if (!['.md', '.markdown'].includes(extname(argument).toLowerCase()))
      throw new Error('Only Markdown files are supported');
    const path = await realpath(argument);
    const file = await open(path, 'r');
    let markdown: string;
    try {
      if (!(await file.stat()).isFile())
        throw new Error('Expected a regular file');
      // Bound the actual read even if the file changes after opening.
      const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > 2 * 1024 * 1024) throw new Error('Document exceeds 2 MiB');
      markdown = new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, length),
      );
    } finally {
      await file.close();
    }
    const url = sourceUrl ?? pathToFileURL(path).href;
    const result = await ingestMarkdown(
      {
        sourceKey: sourceKey ?? pathToFileURL(path).href,
        sourceUrl: url,
        markdown,
      },
      store,
      new OllamaEmbedder(config.EMBEDDING_MODEL, config.OLLAMA_URL),
    );
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    'Operation failed. Check command arguments, file format/size, DATABASE_URL, migrations, and Ollama availability. Existing documents are preserved on ingestion failure.',
  );
  process.exitCode = 1;
});
