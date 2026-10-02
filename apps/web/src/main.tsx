import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { healthSchema } from '@verascribe/contracts';
import './style.css';
const client = new QueryClient();
function App() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const response = await fetch('/api/health');
      if (!response.ok) throw new Error('API unavailable');
      return healthSchema.parse(await response.json());
    },
    retry: 1,
  });
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
          Good answers.
          <br />
          <em>Grounded in evidence.</em>
        </h1>
        <p>
          Ask your documents. Follow every citation. Know when the evidence
          isn’t enough.
        </p>
      </section>
      <section className="panel" aria-labelledby="workspace-title">
        <div className="label">WORKSPACE / 01</div>
        <h2 id="workspace-title">Your knowledge workspace starts here.</h2>
        <p>
          Document ingestion is the first feature in development. Question
          answering will become available once retrieval and evidence
          verification are connected.
        </p>
        <div className="steps">
          <span>01 · Add documents</span>
          <span>02 · Ask a question</span>
          <span>03 · Inspect the evidence</span>
        </div>
      </section>
      <footer>Built for answers you can trace.</footer>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
