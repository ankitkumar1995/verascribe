import 'dotenv/config';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { z } from 'zod';
import { OllamaEmbedder } from '../src/ingestion/embeddings.js';
import { DocumentStore } from '../src/ingestion/store.js';
import { downloadUrl, validateUrl, MAX_PDF_BYTES } from '../src/sources/url.js';
import { parsePdf, parseDownload } from '../src/sources/parse.js';
import { readBoundedFile } from '../src/sources/file.js';
import { ingestParsed } from '../src/sources/ingest.js';
async function main() {
  const [kind, argument, sourceKey, overrideUrl, ...extra] =
    process.argv.slice(2);
  if (
    !argument ||
    !['pdf', 'url'].includes(kind ?? '') ||
    extra.length ||
    (kind === 'url' && overrideUrl)
  )
    throw new Error(
      'Usage: ingest:pdf -- <path> [source-key] [source-url] | ingest:url -- <https-url> [source-key]',
    );
  const config = z
    .object({
      DATABASE_URL: z.string().url(),
      OLLAMA_URL: z.string().url().default('http://127.0.0.1:11434'),
      EMBEDDING_MODEL: z.string().min(1).default('nomic-embed-text'),
    })
    .parse(process.env);
  let source;
  let url: string;
  let key: string;
  if (kind === 'pdf') {
    const path = await realpath(argument);
    url = overrideUrl ?? pathToFileURL(path).href;
    key = sourceKey ?? pathToFileURL(path).href;
    source = await parsePdf(await readBoundedFile(path, MAX_PDF_BYTES));
  } else {
    // Identity stays at the submitted URL; citation URL follows validated redirects.
    key = sourceKey ?? validateUrl(argument).href;
    const download = await downloadUrl(argument);
    url = download.sourceUrl;
    source = await parseDownload(download);
  }
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
  });
  try {
    const result = await ingestParsed(
      { ...source, sourceKey: key, sourceUrl: url },
      new DocumentStore(pool),
      new OllamaEmbedder(config.EMBEDDING_MODEL, config.OLLAMA_URL),
    );
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    'Source ingestion failed. Check format, limits, public HTTPS access, DATABASE_URL and Ollama. Existing documents are preserved on parsing or embedding failure. Scanned/encrypted PDFs require preprocessing.',
  );
  process.exitCode = 1;
});
