import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { pino } from 'pino';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { queryRequestSchema } from '@verascribe/contracts';
describe('API boundary', () => {
  const app = createApp(pino({ level: 'silent' }));
  it('reports liveness without requiring providers', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.headers['x-request-id']).toBeTruthy();
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
  it('returns a JSON 404', async () => {
    expect((await request(app).get('/missing')).body.error.code).toBe(
      'NOT_FOUND',
    );
  });
  it('rejects malformed and oversized bodies', async () => {
    expect(
      (
        await request(app)
          .post('/query')
          .set('Content-Type', 'application/json')
          .send('{')
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/query')
          .send({ question: 'x'.repeat(20_000) })
      ).status,
    ).toBe(413);
  });
  it('rejects invalid settings and questions', () => {
    expect(() => readConfig({ PORT: '-1' })).toThrow();
    expect(queryRequestSchema.safeParse({ question: '   ' }).success).toBe(
      false,
    );
    expect(
      queryRequestSchema.safeParse({ question: 'Hello', unexpected: true })
        .success,
    ).toBe(false);
  });
});
