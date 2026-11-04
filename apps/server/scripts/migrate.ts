import { connectDb, disconnectDb } from '../src/db/connection';
import { runMigrations } from '../src/db/migrator';
import { logger } from '../src/observability/logger';

try {
  // No socket timeout: building an index on a large collection can run well past the app's 30s.
  await connectDb(undefined, undefined, { socketTimeoutMS: 0 });
  const ran = await runMigrations();
  logger.info({ ran }, ran.length ? 'migrations applied, indexes synced' : 'no pending migrations, indexes synced');
  await disconnectDb();
} catch (err) {
  logger.fatal({ err }, 'migration failed');
  process.exit(1);
}
