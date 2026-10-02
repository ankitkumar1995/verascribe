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
const server = createApp(logger, service).listen(
  config.PORT,
  config.HOST,
  () => {
    logger.info({ host: config.HOST, port: config.PORT }, 'API listening');
  },
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => {
      void service?.close().catch(() => {
        process.exitCode = 1;
      });
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
