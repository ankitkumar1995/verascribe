import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  healthSchema,
  queryRequestSchema,
  verifiedAnswerSchema,
  type VerifiedAnswer,
} from '@verascribe/contracts';

const messages: Record<number, string> = {
  400: 'Enter a question between 1 and 2,000 characters.',
  429: 'Too many requests. Wait a moment before trying again.',
  503: 'Question answering is unavailable or busy. Try again shortly.',
  504: 'The answer took too long. Please try again.',
};
export function safeSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {
    /* Local source identifiers are displayed as text. */
  }
  return undefined;
}
export function App() {
  const [question, setQuestion] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [result, setResult] = useState<VerifiedAnswer>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef<AbortController | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [],
  );
  useEffect(() => {
    if (result) resultHeading.current?.focus();
  }, [result]);
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/health', { signal });
      if (!response.ok) throw new Error('API unavailable');
      return healthSchema.parse(await response.json());
    },
    retry: 1,
  });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (active.current) return;
    const input = queryRequestSchema.safeParse({ question });
    if (!input.success) {
      setError(messages[400]!);
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setResult(undefined);
    setError('');
    setNotice('');
    setSubmitted(input.data.question);
    const timer = setTimeout(() => controller.abort(), 310000);
    try {
      const response = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input.data),
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(
          messages[response.status] ??
            'Unable to verify an answer. Please try again.',
        );
      const parsed = verifiedAnswerSchema.safeParse(await response.json());
      if (!parsed.success)
        throw new Error('The answer could not be validated. Please try again.');
      if (active.current === controller) setResult(parsed.data);
    } catch (failure) {
      if (active.current === controller) {
        setError(
          controller.signal.aborted
            ? 'The request timed out. Please try again.'
            : failure instanceof Error &&
                Object.values(messages).includes(failure.message)
              ? failure.message
              : 'Unable to verify an answer. Check your connection and try again.',
        );
      }
    } finally {
      clearTimeout(timer);
      if (active.current === controller) {
        active.current = null;
        setPending(false);
      }
    }
  }
  function cancel() {
    active.current?.abort();
    active.current = null;
    setPending(false);
    setNotice('Request cancelled. You can ask another question.');
  }
  return (
    <main>
      <header>
        <a href="/" aria-label="VeraScribe home">
          Vera<span>Scribe</span>
        </a>
        <span className="status" role="status">
          {health.isPending
            ? 'Connecting…'
            : health.isError
              ? 'API unavailable'
              : 'API connected'}
        </span>
      </header>
      <section className="intro">
        <p className="eyebrow">YOUR KNOWLEDGE, WITH RECEIPTS</p>
        <h1>
          Ask a question.
          <br />
          <em>Follow the evidence.</em>
        </h1>
        <p>
          Answers from your indexed documents, with cited passages you can
          inspect.
        </p>
      </section>
      <section className="panel" aria-labelledby="workspace-title">
        <div className="label">WORKSPACE / 01</div>
        <h2 id="workspace-title">What would you like to know?</h2>
        <form onSubmit={submit}>
          <label htmlFor="question">Your question</label>
          <textarea
            id="question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            maxLength={2000}
            rows={3}
            required
            disabled={pending}
            aria-describedby="question-help"
            placeholder="How long are password reset links valid?"
          />
          <div id="question-help" className="form-help">
            <span>Searches all indexed documents.</span>
            <span>{question.length} / 2,000</span>
          </div>
          <div className="actions">
            <button type="submit" disabled={pending || !question.trim()}>
              {pending ? 'Checking the evidence…' : 'Ask your documents →'}
            </button>
            {pending && (
              <button type="button" className="secondary" onClick={cancel}>
                Cancel
              </button>
            )}
          </div>
        </form>
        <p role="status" aria-live="polite">
          {pending
            ? 'Finding passages and checking the answer. The first question may take longer.'
            : notice}
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
      {result && (
        <section className="results" aria-labelledby="answer-title">
          <div className="answer panel">
            <p className="eyebrow">YOUR ANSWER</p>
            <h2 id="answer-title" tabIndex={-1} ref={resultHeading}>
              {submitted}
            </h2>
            <span className={'badge ' + result.status}>
              {result.status === 'supported'
                ? 'Supported by cited evidence'
                : result.status === 'partial'
                  ? 'Partially supported draft'
                  : 'Insufficient evidence'}
            </span>
            <div className="answer-text">
              {result.status === 'insufficient_evidence' ? (
                <p>{result.answer}</p>
              ) : (
                result.claims.map((claim, index) => (
                  <p key={index}>
                    {claim.text}{' '}
                    {claim.citationIds.map((id) => (
                      <a
                        className="citation"
                        key={id}
                        href={'#source-' + id}
                        aria-label={'Read source ' + id}
                      >
                        [{id}]
                      </a>
                    ))}
                  </p>
                ))
              )}
            </div>
            {result.note && <p className="muted">{result.note}</p>}
            <div className="coverage">
              <strong>
                Draft support coverage · {Math.round(result.confidence * 100)}%
              </strong>
              <meter
                min={0}
                max={1}
                value={result.confidence}
                aria-label="Draft support coverage"
              />
              <p>
                {result.verification.supportedClaims} of{' '}
                {result.verification.assessedClaims} draft statements supported.
                This measures agreement with cited evidence, not the probability
                that an answer is true.
              </p>
            </div>
          </div>
          <aside className="panel sources" aria-labelledby="sources-title">
            <p className="eyebrow">CHECK THE CONTEXT</p>
            <h2 id="sources-title">
              Sources <span className="count">{result.citations.length}</span>
            </h2>
            {!result.citations.length && (
              <p>
                No supporting passages to display. Try a more specific question
                or add relevant documents to the index.
              </p>
            )}
            {result.citations.map((source) => {
              const url = safeSourceUrl(source.sourceUrl);
              return (
                <article
                  id={'source-' + source.id}
                  key={source.id}
                  tabIndex={-1}
                >
                  <h3>
                    [{source.id}] {source.title}
                  </h3>
                  <p className="source-meta">
                    Version {source.version} · Lines {source.metadata.startLine}
                    –{source.metadata.endLine}
                  </p>
                  {source.metadata.headings.length > 0 && (
                    <p className="source-meta">
                      {source.metadata.headings.join(' / ')}
                    </p>
                  )}
                  <blockquote>{source.text}</blockquote>
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      Open original source ↗
                    </a>
                  ) : (
                    <span className="source-location">{source.sourceUrl}</span>
                  )}
                </article>
              );
            })}
          </aside>
        </section>
      )}
      <footer>
        Built for answers you can trace. Always inspect the source context.
      </footer>
    </main>
  );
}
