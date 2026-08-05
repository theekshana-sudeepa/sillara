import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma, prisma } from './lib/prisma.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

async function bootstrap(): Promise<void> {
  await prisma.$connect();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, '🏪 Sillara platform API listening');
  });

  // Every job takes a database lock before it does anything, so running the
  // scheduler on all instances is safe. RUN_JOBS=false exists for the day you
  // would rather one box own it — a config change, not a code change.
  if (env.RUN_JOBS) startScheduler();

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutdown initiated');
    stopScheduler(); // stop taking new work before closing the connection pool
    server.close(async (err) => {
      await disconnectPrisma();
      process.exit(err ? 1 : 0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandled rejection'));
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
