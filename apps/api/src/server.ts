import 'dotenv/config';
import { pino } from 'pino';
import { createApp } from './app.js';
import { readConfig } from './config.js';
const config = readConfig();
const logger = pino({ level: config.LOG_LEVEL });
const server = createApp(logger).listen(config.PORT, config.HOST, () => {
  logger.info({ host: config.HOST, port: config.PORT }, 'API listening');
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
