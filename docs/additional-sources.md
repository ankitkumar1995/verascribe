# PDF and URL ingestion

These administrator CLIs add source formats to the existing versioned index. They do not add browser uploads or a public ingestion endpoint.

## Commands

Configure the database and Ollama using [ingestion setup](ingestion.md), then run:

```sh
npm run ingest:pdf -- "/absolute/path/guide.pdf" guide-pdf
npm run ingest:pdf -- "/absolute/path/guide.pdf" guide-pdf "https://example.com/guide.pdf"
npm run ingest:url -- "https://example.com/help" help-page
```

Use an absolute local path because npm runs the CLI in the API workspace. The PDF command optionally accepts a stable source key and citation URL. By default its key and citation URL are the local file URL. URL ingestion optionally accepts a source key; otherwise the submitted URL (without a fragment) is the identity. Citations use the final validated URL after redirects. Reuse a key to update a source. Existing deletion commands work for all formats.

Repeated identical parsed content, metadata, source URL, and embedding model skip embeddings and writes. Changed content replaces chunks atomically and increments the version. Parsing and download failures occur before writes; embedding or transaction failures preserve the prior document. Database-stage runs use the existing ingestion audit. Pre-database parsing/download failures are reported by the CLI rather than inserted as audit rows.

## PDFs

PDF.js extracts text in a separate Node process. Limits are 10 MiB input, 100 pages, 500,000 extracted characters, 2 MiB parser output, a 30-second wall deadline, and a 256 MiB V8 heap. The heap setting is not an operating-system memory limit. The parser receives no provider credentials and does not fetch external document resources.

Each chunk stays within one PDF page. Citations preserve the one-based page number and distinguish extracted-text line numbers from original Markdown lines. Tables, columns, and reading order can lose layout during text extraction. This release has no OCR; PDFs with any empty or image-only page, encrypted PDFs, and malformed PDFs fail rather than silently indexing an incomplete document. Preprocess those files before ingestion. PDF titles currently use “PDF document.”

## Web sources

Only credential-free public HTTPS URLs on port 443 are supported. Each DNS result must be public, including every redirect destination. Requests use a validated, pinned address while retaining the URL hostname for TLS verification. Loopback, private, link-local, multicast, benchmark, documentation, translation/tunnel and other special-purpose ranges are rejected conservatively. At most three redirects are followed, with a 20-second total download deadline. No cookies, authentication headers, proxy agent, or automatic retries are sent.

Accepted MIME types are HTML, plain text, Markdown, and PDF. Text/HTML bodies are limited to 2 MiB; PDF bodies to 10 MiB. Limits apply while streaming, independently of Content-Length. Compressed responses are rejected to avoid decompression ambiguity. Text must decode as UTF-8.

HTML extraction uses main/article content when present and removes scripts, styles, navigation, forms, and explicitly hidden content. It never executes JavaScript, loads images, or follows page links. It is a single-page importer, not a crawler; JavaScript-only sites and login pages need an exported text source. Extracted line numbers refer to the normalized text rather than HTML source lines.

## Validation and references

Tests cover special IP ranges and encoded loopback URLs, DNS/redirect validation, pinned connection options, unsupported/compressed responses, streamed byte limits, real multipage PDF extraction, parser deadlines, metadata propagation, atomic updates, and UI page labels. Provider embeddings use controlled fixtures in integration tests.

Implementation references: [PDF.js Node example](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs), [Cheerio loading](https://cheerio.js.org/docs/basics/loading/), and [Node DNS lookup](https://nodejs.org/api/dns.html).
