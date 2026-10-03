import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { pino } from 'pino';
import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { runDiagnostics } from '../src/operations/doctor.js';
import {
  evaluateVerification,
  verificationDatasetSchema,
} from '../src/guardrails/evaluation.js';
import { createQueryService } from '../src/query/service.js';
import type { NliResult } from '../src/guardrails/nli.js';
const dataset = [
  { id: 'yes', premise: 'A', hypothesis: 'A', label: 'entailment' as const },
  {
    id: 'no',
    premise: 'A',
    hypothesis: 'Not A',
    label: 'contradiction' as const,
  },
  { id: 'unknown', premise: 'A', hypothesis: 'B', label: 'neutral' as const },
];
const scores: NliResult[] = [
  {
    status: 'scored',
    probabilities: { entailment: 0.98, neutral: 0.01, contradiction: 0.01 },
  },
  {
    status: 'scored',
    probabilities: { entailment: 0.01, neutral: 0.01, contradiction: 0.98 },
  },
  {
    status: 'scored',
    probabilities: { entailment: 0.01, neutral: 0.98, contradiction: 0.01 },
  },
];
describe('release evaluation gate', () => {
  it('passes a complete correct diagnostic set', () => {
    const report = evaluateVerification(dataset, scores, 0.8);
    expect(report.gate.passed).toBe(true);
    expect(report.summary.acceptedPrecision).toBe(1);
  });
  it('fails on false accepts or a verifier that never accepts', () => {
    expect(
      evaluateVerification(dataset, [scores[0]!, scores[0]!, scores[2]!], 0.8)
        .gate.passed,
    ).toBe(false);
    expect(
      evaluateVerification(
        dataset,
        dataset.map(() => ({ status: 'input_too_long' })),
        0.8,
      ).gate.passed,
    ).toBe(false);
  });
  it('rejects empty/duplicate/count-mismatched data and gates incomplete label sets', () => {
    expect(() => verificationDatasetSchema.parse([])).toThrow();
    expect(() =>
      verificationDatasetSchema.parse([dataset[0], dataset[0]]),
    ).toThrow();
    expect(() => evaluateVerification(dataset, [], 0.8)).toThrow();
    expect(
      evaluateVerification([dataset[0]!], [scores[0]!], 0.8).gate.passed,
    ).toBe(false);
  });
});
describe('local release operations', () => {
  it('serves the UI, preserves API aliases, and never serves dotfiles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'verascribe-web-'));
    try {
      await writeFile(
        join(directory, 'index.html'),
        '<html>VeraScribe release</html>',
      );
      await writeFile(join(directory, '.env'), 'private');
      const app = createApp(pino({ level: 'silent' }), undefined, {
        webDir: directory,
      });
      const page = await request(app).get('/');
      expect(page.status).toBe(200);
      expect(page.text).toContain('VeraScribe release');
      expect(page.headers['cache-control']).toBe('no-cache');
      expect((await request(app).get('/api/health')).body.status).toBe('ok');
      expect(
        (await request(app).post('/api/query').send({ question: 'hello' }))
          .status,
      ).toBe(503);
      expect((await request(app).get('/api/missing')).status).toBe(404);
      expect((await request(app).get('/.env')).text).not.toContain('private');
    } finally {
      await rm(join(directory, 'index.html'), { force: true });
      await rm(join(directory, '.env'), { force: true });
      await rmdir(directory);
    }
  });
  it('diagnoses independent failures without revealing raw errors', async () => {
    const last = vi.fn(async () => {});
    const report = await runDiagnostics([
      {
        name: 'first',
        run: async () => {
          throw new Error('password=secret');
        },
        success: 'ok',
        failure: 'Database unavailable',
      },
      { name: 'next', run: last, success: 'Configured', failure: 'Missing' },
    ]);
    expect(report.ready).toBe(false);
    expect(last).toHaveBeenCalledOnce();
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(report.checks[1]?.passed).toBe(true);
  });
  it('cancels shutdown work and disposes resources exactly once', async () => {
    let signal: AbortSignal | undefined;
    let finish!: () => void;
    const dispose = vi.fn(async () => {});
    const service = createQueryService(async (_input, received) => {
      signal = received;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      throw new Error('cancelled work');
    }, dispose);
    const pending = service.answer({ question: 'hello' });
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    await Promise.resolve();
    const first = service.close();
    const second = service.close();
    expect(signal?.aborted).toBe(true);
    expect(first).toBe(second);
    expect(dispose).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, second, rejected]);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
