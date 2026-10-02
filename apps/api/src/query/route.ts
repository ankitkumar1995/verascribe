import { Router } from 'express';
import {
  queryRequestSchema,
  verifiedAnswerSchema,
} from '@verascribe/contracts';
import { GenerationError } from '../generation/types.js';
import { QueryError, type QueryService } from './service.js';
export function queryRouter(service?: QueryService) {
  const router = Router();
  router.post('/query', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.is('application/json')) {
      res.status(415).json({
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Send a JSON request.',
        },
      });
      return;
    }
    const input = queryRequestSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Enter a question between 1 and 2,000 characters.',
        },
      });
      return;
    }
    if (!service) {
      res.status(503).json({
        error: {
          code: 'UNAVAILABLE',
          message: 'Question answering is not configured yet.',
        },
      });
      return;
    }
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', cancel);
    try {
      const answer = verifiedAnswerSchema.parse(
        await service.answer(input.data, controller.signal),
      );
      if (!res.destroyed) res.json(answer);
    } catch (error) {
      if (res.destroyed) return;
      const code =
        error instanceof QueryError
          ? error.code
          : error instanceof GenerationError && error.code === 'TIMEOUT'
            ? 'TIMEOUT'
            : 'QUERY_FAILED';
      const status =
        code === 'TIMEOUT'
          ? 504
          : code === 'BUSY' || code === 'UNAVAILABLE'
            ? 503
            : code === 'CANCELLED'
              ? 408
              : 502;
      const message =
        code === 'BUSY'
          ? 'Another question is being processed. Try again shortly.'
          : code === 'TIMEOUT'
            ? 'The answer took too long. Please try again.'
            : code === 'UNAVAILABLE'
              ? 'Question answering is unavailable.'
              : code === 'CANCELLED'
                ? 'The request was cancelled.'
                : 'Unable to verify an answer. Please try again.';
      if (code === 'BUSY') res.setHeader('Retry-After', '5');
      req.log.warn({ code }, 'Query did not complete');
      res.status(status).json({ error: { code, message } });
    } finally {
      res.off('close', cancel);
    }
  });
  return router;
}
