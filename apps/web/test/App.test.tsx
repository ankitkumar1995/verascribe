// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App, safeSourceUrl } from '../src/App';
import { FALLBACK_ANSWER } from '@verascribe/contracts';
const evidence = {
  status: 'supported',
  answer: 'Links expire in 30 minutes. [1]',
  confidence: 1,
  claims: [{ text: 'Links expire in 30 minutes.', citationIds: [1] }],
  citations: [
    {
      id: 1,
      title: 'Password help',
      text: 'Links expire in 30 minutes.',
      sourceUrl: 'https://example.com/help',
      chunkId: '11111111-1111-4111-8111-111111111111',
      documentId: '22222222-2222-4222-8222-222222222222',
      version: 2,
      metadata: { headings: ['Account'], startLine: 2, endLine: 4 },
    },
  ],
  verification: {
    model: 'test',
    revision: 'test',
    entailmentThreshold: 0.8,
    minimumSupportRatio: 0.5,
    assessedClaims: 1,
    supportedClaims: 1,
    returnedClaims: 1,
    assessments: [{ claimIndex: 0, outcome: 'entailed' }],
  },
  note: null,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(query: () => Promise<Response>) {
  const fetcher = vi.fn((url: string) =>
    url === '/api/health'
      ? Promise.resolve(
          Response.json({ status: 'ok', service: 'verascribe-api' }),
        )
      : query(),
  );
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), fetcher };
}
async function ask(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    screen.getByLabelText('Your question'),
    'When do links expire?',
  );
  await user.click(screen.getByRole('button', { name: /Ask your documents/ }));
}
describe('question workspace', () => {
  it('links verified claims to traceable source context', async () => {
    const { user, fetcher } = setup(async () => Response.json(evidence));
    await ask(user);
    await screen.findByText('Supported by cited evidence');
    expect(
      screen.getByRole('link', { name: 'Read source 1' }).getAttribute('href'),
    ).toBe('#source-1');
    expect(screen.getByText('Version 2 · Lines 2–4')).toBeTruthy();
    expect(screen.getByRole('meter').getAttribute('value')).toBe('1');
    expect(document.activeElement?.id).toBe('answer-title');
    expect(
      fetcher.mock.calls.filter(([url]) => url === '/api/query'),
    ).toHaveLength(1);
  });
  it('renders partial coverage without suggesting truth probability', async () => {
    const { user } = setup(async () =>
      Response.json({
        ...evidence,
        status: 'partial',
        confidence: 0.5,
        note: 'Unsupported statements were removed.',
      }),
    );
    await ask(user);
    expect(await screen.findByText('Partially supported draft')).toBeTruthy();
    expect(screen.getByText(/not the probability/)).toBeTruthy();
    expect(
      screen.getByText('Unsupported statements were removed.'),
    ).toBeTruthy();
  });
  it('shows no source cards on insufficient evidence', async () => {
    const { user } = setup(async () =>
      Response.json({
        ...evidence,
        status: 'insufficient_evidence',
        answer: FALLBACK_ANSWER,
        confidence: 0,
        claims: [],
        citations: [],
      }),
    );
    await ask(user);
    expect(await screen.findByText(FALLBACK_ANSWER)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Read source/ })).toBeNull();
  });
  it('shows retryable errors without provider error content', async () => {
    const { user } = setup(async () =>
      Response.json({ error: 'secret' }, { status: 503 }),
    );
    await ask(user);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'unavailable or busy',
    );
    expect(screen.queryByText('secret')).toBeNull();
  });
  it('ignores late responses after cancellation', async () => {
    let resolve!: (response: Response) => void;
    const { user } = setup(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await ask(user);
    expect(
      (screen.getByLabelText('Your question') as HTMLTextAreaElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    resolve(Response.json(evidence));
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Your question') as HTMLTextAreaElement)
          .disabled,
      ).toBe(false),
    );
    expect(screen.queryByText('Supported by cited evidence')).toBeNull();
    expect(screen.getByText(/Request cancelled/)).toBeTruthy();
  });
  it('rejects malformed answer payloads', async () => {
    const { user } = setup(async () => Response.json({ answer: 'unsafe' }));
    await ask(user);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('unsafe')).toBeNull();
  });
  it('shows PDF page references and distinguishes extracted lines', async () => {
    const { user } = setup(async () =>
      Response.json({
        ...evidence,
        citations: [
          {
            ...evidence.citations[0],
            metadata: {
              headings: [],
              startLine: 2,
              endLine: 4,
              page: 3,
              lineBasis: 'extracted',
            },
          },
        ],
      }),
    );
    await ask(user);
    expect(
      await screen.findByText('Version 2 · Page 3 · Extracted lines 2–4'),
    ).toBeTruthy();
  });
  it('only links credential-free HTTP(S) source URLs', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///private',
      'data:text/html,test',
      'https://user:pass@example.com',
      'local-document',
    ])
      expect(safeSourceUrl(url)).toBeUndefined();
    expect(safeSourceUrl('https://example.com/a')).toBe(
      'https://example.com/a',
    );
  });
});
