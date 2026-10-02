import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { pino } from 'pino';
import { FALLBACK_ANSWER, type VerifiedAnswer } from '@verascribe/contracts';
import { createApp } from '../src/app.js';
import {
  createQueryService,
  QueryError,
  type QueryService,
} from '../src/query/service.js';
import { createQueryRuntime } from '../src/query/runtime.js';
import { GenerationError } from '../src/generation/types.js';
const result: VerifiedAnswer = {
  status: 'insufficient_evidence',
  answer: FALLBACK_ANSWER,
  confidence: 0,
  claims: [],
  citations: [],
  note: null,
  verification: {
    model: 'test',
    revision: 'test',
    entailmentThreshold: 0.8,
    minimumSupportRatio: 0.5,
    assessedClaims: 0,
    supportedClaims: 0,
    returnedClaims: 0,
    assessments: [],
  },
};
const logger = pino({ level: 'silent' });
const service = (answer: QueryService['answer']): QueryService => ({
  answer,
  close: async () => {},
});
describe('query HTTP boundary', () => {
  it('returns only validated answers without caching', async () => {
    const answer = vi.fn<QueryService['answer']>(async () => result);
    const response = await request(createApp(logger, service(answer)))
      .post('/query')
      .send({ question: '  Hello?  ' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(answer.mock.calls[0]?.[0]).toEqual({ question: 'Hello?' });
  });
  it('rejects unknown fields, invalid questions and wrong content type before inference', async () => {
    const answer = vi.fn(async () => result);
    const app = createApp(logger, service(answer));
    for (const body of [
      { question: ' ' },
      { question: 'x'.repeat(2001) },
      { question: 'hi', sourceKeys: ['private'] },
      { question: 3 },
    ]) {
      expect((await request(app).post('/query').send(body)).status).toBe(400);
    }
    expect(
      (await request(app).post('/query').type('text').send('hi')).status,
    ).toBe(415);
    expect(answer).not.toHaveBeenCalled();
  });
  it('stays live when answering is not configured', async () => {
    const app = createApp(logger);
    expect(
      (await request(app).post('/query').send({ question: 'hi' })).status,
    ).toBe(503);
    expect((await request(app).get('/health')).status).toBe(200);
    expect(createQueryRuntime({})).toBeUndefined();
    expect(() => createQueryRuntime({ QUERY_ENABLED: 'true' })).toThrow();
  });
  it.each([
    [new QueryError('BUSY'), 503, 'BUSY'],
    [new QueryError('TIMEOUT'), 504, 'TIMEOUT'],
    [new GenerationError('TIMEOUT'), 504, 'TIMEOUT'],
    [new Error('secret key and private document'), 502, 'QUERY_FAILED'],
  ])('sanitizes failures %#', async (error, status, code) => {
    const response = await request(
      createApp(
        logger,
        service(async () => {
          throw error;
        }),
      ),
    )
      .post('/query')
      .send({ question: 'hi' });
    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
    expect(JSON.stringify(response.body)).not.toContain('secret');
    if (code === 'BUSY') expect(response.headers['retry-after']).toBe('5');
  });
  it('rejects invalid service output', async () => {
    const response = await request(
      createApp(
        logger,
        service(async () => ({ answer: 'unverified' }) as VerifiedAnswer),
      ),
    )
      .post('/query')
      .send({ question: 'hi' });
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain('unverified');
  });
});
describe('bounded query execution', () => {
  it('retains admission after timeout until underlying work settles', async () => {
    let resolve!: (value: VerifiedAnswer) => void;
    const dispose = vi.fn(async () => {});
    const query = createQueryService(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
      dispose,
      10,
    );
    await expect(query.answer({ question: 'hello' })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    await expect(query.answer({ question: 'again' })).rejects.toMatchObject({
      code: 'BUSY',
    });
    const closing = query.close();
    expect(dispose).not.toHaveBeenCalled();
    resolve(result);
    await closing;
    expect(dispose).toHaveBeenCalledOnce();
    await expect(query.answer({ question: 'later' })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });
  it('propagates cancellation without prematurely releasing the model', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    let reject!: (error: Error) => void;
    const query = createQueryService(
      async (_request, signal) => {
        received = signal;
        return new Promise((_resolve, fail) => {
          reject = fail;
        });
      },
      async () => {},
    );
    const pending = query.answer({ question: 'hello' }, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(received?.aborted).toBe(true);
    await expect(query.answer({ question: 'again' })).rejects.toMatchObject({
      code: 'BUSY',
    });
    reject(new Error('aborted'));
    await query.close();
  });
  it('rejects pre-cancelled and invalid requests and recovers after failure', async () => {
    const run = vi.fn(async () => result);
    const query = createQueryService(run, async () => {});
    await expect(
      query.answer({ question: 'hello' }, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(query.answer({ question: ' ' })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    run.mockRejectedValueOnce(new Error('provider'));
    await expect(query.answer({ question: 'hello' })).rejects.toThrow(
      'provider',
    );
    expect(await query.answer({ question: 'hello' })).toEqual(result);
    await query.close();
  });
});
