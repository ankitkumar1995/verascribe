import {
  queryRequestSchema,
  verifiedAnswerSchema,
  type QueryRequest,
  type VerifiedAnswer,
} from '@verascribe/contracts';
export class QueryError extends Error {
  constructor(readonly code: 'BUSY' | 'TIMEOUT' | 'CANCELLED' | 'UNAVAILABLE') {
    super(code);
  }
}
export type AnswerFunction = (
  request: QueryRequest,
  signal: AbortSignal,
) => Promise<VerifiedAnswer>;
export interface QueryService {
  answer(request: QueryRequest, signal?: AbortSignal): Promise<VerifiedAnswer>;
  close(): Promise<void>;
}
// A timed-out caller must not release the model slot while native work continues.
export function createQueryService(
  run: AnswerFunction,
  dispose: () => Promise<void>,
  timeoutMs = 120000,
): QueryService {
  let active: Promise<VerifiedAnswer> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let activeController: AbortController | undefined;
  return {
    async answer(input, signal) {
      const request = queryRequestSchema.parse(input);
      if (closed) throw new QueryError('UNAVAILABLE');
      if (active) throw new QueryError('BUSY');
      if (signal?.aborted) throw new QueryError('CANCELLED');
      const controller = new AbortController();
      activeController = controller;
      const cancel = () => controller.abort(new QueryError('CANCELLED'));
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(
        () => controller.abort(new QueryError('TIMEOUT')),
        timeoutMs,
      );
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      const work = Promise.resolve()
        .then(() => run(request, controller.signal))
        .then((value) => verifiedAnswerSchema.parse(value));
      active = work;
      void work
        .finally(() => {
          if (active === work) {
            active = undefined;
            activeController = undefined;
          }
        })
        .catch(() => {});
      try {
        return await Promise.race([work, aborted]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        controller.signal.removeEventListener('abort', onAbort);
      }
    },
    close() {
      closed = true;
      activeController?.abort(new QueryError('UNAVAILABLE'));
      closing ??= (async () => {
        await active?.catch(() => {});
        await dispose();
      })();
      return closing;
    },
  };
}
