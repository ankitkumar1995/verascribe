import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createQueryRuntime } from './query/runtime.js';
const config = readConfig();
const logger = pino({ level: config.LOG_LEVEL });
let service: ReturnType<typeof createQueryRuntime>;
try {
  service = createQueryRuntime(
    process.env,
    fileURLToPath(new URL('../../../.local/models/', import.meta.url)),
  );
} catch {
  logger.fatal(
    'Invalid question-answering configuration. Check server environment settings.',
  );
  process.exit(1);
}
const server = createApp(
  logger,
  service,
  config.SERVE_WEB
    ? {
        webDir: fileURLToPath(new URL('../../web/dist/', import.meta.url)),
      }
    : {},
).listen(config.PORT, config.HOST, () =>
  logger.info({ host: config.HOST, port: config.PORT }, 'API listening'),
);
server.headersTimeout = 15000;
server.requestTimeout = 20000; // Receiving the request, not the query execution deadline.
server.keepAliveTimeout = 5000;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down');
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    const closed = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    void Promise.all([closed, service?.close()])
      .then(() => {
        clearTimeout(deadline);
        logger.info('Shutdown complete');
      })
      .catch(() => {
        logger.error('Shutdown cleanup failed');
        process.exitCode = 1;
      });
  });
}
