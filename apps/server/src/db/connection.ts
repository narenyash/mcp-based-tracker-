import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../observability/logger';

const SLOW_QUERY_MS = 200;

/**
 * `socketTimeoutMS`: a query on a dead connection errors instead of hanging the request. Long-running
 * commands that send nothing back until done (index builds in migrations) should pass 0 (no timeout).
 */
export async function connectDb(
  uri: string = env.mongo.uri,
  dbName: string | undefined = env.mongo.dbName,
  { socketTimeoutMS = 30_000 }: { socketTimeoutMS?: number } = {},
): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  // Collections, validators and indexes are owned by migrations (npm run db:migrate),
  // never created implicitly by the app at runtime.
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);

  const conn = await mongoose.connect(uri, {
    maxPoolSize: 50,
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS,
    retryWrites: true,
    w: 'majority',
    monitorCommands: true,
    ...(dbName ? { dbName } : {}),
  });

  const client = conn.connection.getClient();
  client.on('commandSucceeded', (e) => {
    if (e.duration > SLOW_QUERY_MS) {
      logger.warn({ command: e.commandName, durationMs: e.duration }, 'slow mongo command');
    }
  });

  logger.info({ db: conn.connection.name }, 'mongo connected');
  return conn;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

export async function pingDb(): Promise<boolean> {
  try {
    await mongoose.connection.db?.admin().ping();
    return true;
  } catch {
    return false;
  }
}
