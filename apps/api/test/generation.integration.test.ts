import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../src/db/migrate.js';
import { DocumentStore } from '../src/ingestion/store.js';
import { OllamaEmbedder } from '../src/ingestion/embeddings.js';
import { PostgresSearch } from '../src/retrieval/postgres.js';
import {
  CrossEncoderReranker,
  type PairScorer,
} from '../src/reranking/local.js';
import { GroqGenerator } from '../src/generation/groq.js';
import { answerDraft } from '../src/generation/pipeline.js';

import { LocalNliVerifier } from '../src/guardrails/nli.js';
import { answerVerified } from '../src/guardrails/pipeline.js';

import request from 'supertest';
import { pino } from 'pino';
import { createApp } from '../src/app.js';
import { createQueryService } from '../src/query/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'draft pipeline with real database and controlled provider HTTP',
  () => {
    const pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5000,
    });
    const store = new DocumentStore(pool);
    const key = 'generation-' + randomUUID();
    const model = 'nomic-embed-text:test-' + randomUUID();
    const vector = [1, ...Array<number>(767).fill(0)];
    const realReranker =
      process.env.RUN_MODEL_TESTS === 'true'
        ? new CrossEncoderReranker()
        : undefined;
    const reranker: PairScorer = realReranker ?? {
      model: 'test',
      revision: 'test',
      score: async (_question, passages) =>
        passages.map(() => ({ score: 1, truncated: false })),
    };
    const verifier = new LocalNliVerifier();
    let server: Server;
    let baseUrl: string;
    let mode: 'valid' | 'invalid-citation' | 'slow-body' = 'valid';
    beforeAll(async () => {
      await migrate(pool);
      await store.replace({
        sourceKey: key,
        sourceUrl: 'https://example.com/passwords',
        title: 'Passwords',
        fingerprint: 'v1',
        model,
        chunks: [
          {
            content: 'Password reset links expire after 30 minutes.',
            metadata: {
              headings: ['Passwords'],
              startLine: 1,
              endLine: 1,
              page: 2,
              lineBasis: 'extracted',
            },
          },
        ],
        vectors: [vector],
      });
      await realReranker?.prepare();
      server = createServer(async (req, res) => {
        try {
          const parts = [];
          for await (const part of req) parts.push(Buffer.from(part));
          const body = JSON.parse(Buffer.concat(parts).toString());
          if (req.url === '/api/embed') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ embeddings: body.input.map(() => vector) }),
            );
            return;
          }
          if (mode === 'slow-body') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write('{"choices":');
            const timer = setTimeout(() => res.end('[]}'), 500);
            res.on('close', () => clearTimeout(timer));
            return;
          }
          const context = JSON.parse(body.messages[1].content).evidence;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [
                {
                  finish_reason: 'stop',
                  message: {
                    content: JSON.stringify({
                      status: 'answer',
                      claims: [
                        {
                          text: 'Password reset links expire after 30 minutes.',
                          citations: [
                            mode === 'invalid-citation'
                              ? 999
                              : context[0].number,
                          ],
                        },
                      ],
                    }),
                  },
                },
              ],
            }),
          );
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing address');
      baseUrl = 'http://127.0.0.1:' + address.port;
    }, 120000);
    afterAll(async () => {
      if (server)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      try {
        await verifier.dispose();
        await realReranker?.dispose();
        await store.delete(key);
      } finally {
        await pool.end();
      }
    });
    const generator = (timeoutMs = 30000) =>
      new GroqGenerator({ apiKey: 'test-only', timeoutMs }, (_url, init) =>
        fetch(baseUrl + '/chat', init),
      );
    const dependencies = () => ({
      backend: new PostgresSearch(pool),
      embedder: new OllamaEmbedder(model, baseUrl),
      reranker,
      generator: generator(),
    });
    it('returns a traceable unverified draft through all pipeline stages', async () => {
      const result = await answerDraft(
        { question: 'When do password reset links expire?', sourceKeys: [key] },
        dependencies(),
      );
      expect(result.answer).toBe(
        'Password reset links expire after 30 minutes. [1]',
      );
      expect(result.verification).toBe('pending');
      expect(result.citations[0]).toMatchObject({
        sourceUrl: 'https://example.com/passwords',
        version: 1,
        text: 'Password reset links expire after 30 minutes.',
      });
    }, 30000);
    it.skipIf(process.env.RUN_MODEL_TESTS !== 'true')(
      'verifies the complete pipeline',
      async () => {
        mode = 'valid';
        const result = await answerVerified(
          {
            question: 'When do password reset links expire?',
            sourceKeys: [key],
          },
          { ...dependencies(), verifier },
        );
        expect(result.status).toBe('supported');
        expect(result.confidence).toBe(1);
        expect(result.verification.returnedClaims).toBe(1);
        expect(result.answer).toBe(
          'Password reset links expire after 30 minutes. [1]',
        );
        expect(result.citations[0]?.sourceUrl).toBe(
          'https://example.com/passwords',
        );
      },
      120000,
    );
    it.skipIf(process.env.RUN_MODEL_TESTS !== 'true')(
      'serves a verified answer through HTTP',
      async () => {
        mode = 'valid';
        const service = createQueryService(
          (input, signal) =>
            answerVerified(
              { ...input, sourceKeys: [key] },
              { ...dependencies(), verifier },
              {},
              signal,
            ),
          async () => {},
        );
        try {
          const response = await request(
            createApp(pino({ level: 'silent' }), service),
          )
            .post('/query')
            .send({ question: 'When do password reset links expire?' });
          expect(response.status).toBe(200);
          expect(response.body.status).toBe('supported');
          expect(response.body.citations[0].metadata).toMatchObject({
            page: 2,
            lineBasis: 'extracted',
          });
          expect(response.body.citations[0].sourceUrl).toBe(
            'https://example.com/passwords',
          );
          expect(response.body.answer).toBe(
            'Password reset links expire after 30 minutes. [1]',
          );
        } finally {
          await service.close();
        }
      },
      120000,
    );
    it('fails closed when the provider fabricates a citation', async () => {
      mode = 'invalid-citation';
      await expect(
        answerDraft(
          { question: 'When do links expire?', sourceKeys: [key] },
          dependencies(),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    }, 30000);
    it('enforces the timeout while streaming the response body', async () => {
      mode = 'slow-body';
      await expect(
        generator(100).complete([{ role: 'user', content: '{}' }]),
      ).rejects.toMatchObject({ code: 'TIMEOUT' });
    });
  },
);
