import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import { queryRouter } from './query/route.js';
import type { QueryService } from './query/service.js';
export function createApp(
  logger: Logger,
  service?: QueryService,
  options: { webDir?: string } = {},
) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => {
        const id = randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      serializers: {
        req: (req: { id: string; method: string }) => ({
          id: req.id,
          method: req.method,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.get(['/health', '/api/health'], (_req, res) =>
    res.json({ status: 'ok', service: 'verascribe-api' }),
  );
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 60,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: {
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Try again shortly.',
        },
      },
    }),
  );
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', queryRouter(service));
  app.use(queryRouter(service));
  if (options.webDir) {
    app.use(
      express.static(options.webDir, {
        index: false,
        dotfiles: 'deny',
        maxAge: '1h',
      }),
    );
    app.get('/', (_req, res) =>
      res.sendFile(join(options.webDir!, 'index.html'), {
        headers: { 'Cache-Control': 'no-cache' },
      }),
    );
  }
  app.use((_req, res) =>
    res
      .status(404)
      .json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }),
  );
  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    req,
    res,
    next,
  ) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? error.status
        : undefined;
    if (status === 400 || status === 413) {
      res.status(status).json({
        error: {
          code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON',
          message: 'Invalid request body.',
        },
      });
      return;
    }
    req.log.error({ requestId: req.id }, 'Request failed');
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      },
    });
  };
  app.use(errorHandler);
  return app;
}
