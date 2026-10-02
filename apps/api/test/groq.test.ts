import { describe, expect, it, vi } from 'vitest';
import { GroqGenerator } from '../src/generation/groq.js';
import type { GenerationMessage } from '../src/generation/types.js';

const messages: GenerationMessage[] = [
  { role: 'system', content: 'Return JSON.' },
  { role: 'user', content: '{}' },
];
const envelope = (
  content = '{"status":"insufficient_evidence","claims":[]}',
) => ({
  choices: [{ finish_reason: 'stop', message: { content } }],
});
describe('Groq boundary', () => {
  it('uses the fixed endpoint, JSON mode, bounded output, and a cancellation signal', async () => {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        messages,
        response_format: { type: 'json_object' },
        temperature: 0,
        max_completion_tokens: 1500,
      });
      return Response.json(envelope());
    });
    expect(
      await new GroqGenerator({ apiKey: 'test-key' }, request).complete(
        messages,
      ),
    ).toContain('insufficient_evidence');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([429, 401, 500])(
    'does not leak provider error bodies or credentials for HTTP %i',
    async (status) => {
      const request = vi.fn<typeof fetch>(
        async () => new Response('test-key secret-document', { status }),
      );
      const promise = new GroqGenerator(
        { apiKey: 'test-key' },
        request,
      ).complete(messages);
      await expect(promise).rejects.toMatchObject({
        code: status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
      });
      await promise.catch((error) => {
        expect(error.message).not.toMatch(/test-key|secret-document/);
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { choices: [] },
    { choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: null } }] },
  ])('rejects incomplete provider responses', async (body) => {
    const request = vi.fn<typeof fetch>(async () => Response.json(body));
    await expect(
      new GroqGenerator({ apiKey: 'test-key' }, request).complete(messages),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
  it('rejects malformed and oversized response bodies', async () => {
    for (const body of ['not-json', 'x'.repeat(65537)]) {
      const request = vi.fn<typeof fetch>(async () => new Response(body));
      await expect(
        new GroqGenerator({ apiKey: 'test-key' }, request).complete(messages),
      ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    }
  });
  it('bounds request duration and sanitizes timeout errors', async () => {
    const request = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('internal test-key')),
            { once: true },
          );
        }),
    );
    await expect(
      new GroqGenerator(
        { apiKey: 'test-key', timeoutMs: 20 },
        request,
      ).complete(messages),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
  it('honors caller cancellation without making a request', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn<typeof fetch>();
    await expect(
      new GroqGenerator({ apiKey: 'test-key' }, request).complete(
        messages,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(request).not.toHaveBeenCalled();
  });
  it('sanitizes network exceptions', async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error('test-key secret-question');
    });
    await expect(
      new GroqGenerator({ apiKey: 'test-key' }, request).complete(messages),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'The generation provider failed.',
    });
  });
});
