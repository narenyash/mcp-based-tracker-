import { createServer } from 'node:http';
import { env, isProd } from './config/env';
import { logger } from './observability/logger';
import { markDraining } from './observability/lifecycle';
import { connectDb, disconnectDb } from './db/connection';
import { pendingMigrations } from './db/migrator';
import { createApp } from './app';
import { startOutboxWorker } from './workers/outboxWorker';
import { attachRealtime, closeRealtime } from './services/realtime';
import { verifyMailer } from './services/mailer';
import { startScheduler } from './jobs/scheduler';
import { ALL_JOBS } from './jobs';
import { projectsService } from './modules/projects/projects.service';
import { NotFoundError } from './errors/AppError';

async function main(): Promise<void> {
  await connectDb();

  const pending = await pendingMigrations();
  if (pending.length > 0) {
    const msg = `Pending migrations: ${pending.join(', ')}. Run "npm run db:migrate".`;
    if (isProd) throw new Error(msg);
    logger.warn(msg);
  }

  const server = createServer(createApp());
  attachRealtime(server, async (ctx, projectId) => {
    try {
      await projectsService.access(ctx, projectId);
      return true;
    } catch (err) {
      if (err instanceof NotFoundError) return false;
      throw err;
    }
  });
  // Reject (instead of crashing later) if the port is taken, so main().catch logs it and exits 1.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.PORT, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info({ port: env.PORT }, 'server listening');
  void verifyMailer();
  const worker = startOutboxWorker();
  const scheduler = startScheduler(ALL_JOBS);

  /*
   * Shutdown order:
   *  1. mark draining, so /readyz turns 503 and the load balancer stops sending new traffic;
   *  2. disconnect sockets and stop accepting connections (io.close() also closes the HTTP server),
   *     letting in-flight requests finish; at the same time let the worker finish its current message
   *     and the scheduler its current job (both lease-based, so a cut-off run is retried elsewhere);
   *  3. close Mongo last, once nothing can still be using it.
   * Anything still running at SHUTDOWN_TIMEOUT_MS is cut off and the process exits 1.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error({ timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, 'graceful shutdown timed out; forcing exit');
      server.closeAllConnections();
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS).unref();
    try {
      markDraining();
      await Promise.all([closeRealtime(), worker.stop(), scheduler.stop()]);
      server.closeAllConnections(); // no-op normally; drops any keep-alive socket that outlived close()
      await disconnectDb();
      logger.info('shutdown complete');
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      exitCode = 1;
    }
    clearTimeout(force);
    process.exit(exitCode);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
  // State is unknown after an uncaught exception: stop cleanly (lets in-flight work finish) and exit 1.
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
