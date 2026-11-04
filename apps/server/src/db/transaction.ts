import mongoose, { type ClientSession } from 'mongoose';

/**
 * Runs `fn` inside a majority-committed transaction. The driver retries the whole callback on
 * TransientTransactionError and the commit on UnknownTransactionCommitResult, so `fn` must be
 * idempotent with respect to anything outside the database (no emails, no sockets: use the outbox).
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' },
    );
    return result as T;
  } finally {
    await session.endSession();
  }
}
