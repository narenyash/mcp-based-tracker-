import type { ClientSession } from 'mongoose';
import { Outbox, type OutboxType } from '../models/Outbox';
import type { EmailJob } from './mailer';
import type { NotifyJob } from './notifier';

interface OutboxPayloads {
  'email.send': EmailJob;
  notify: NotifyJob;
}

export type OutboxMessage<K extends OutboxType = OutboxType> = {
  [T in K]: {
    type: T;
    payload: OutboxPayloads[T];
    /** Same key twice = one side effect, even if the transaction body is retried. */
    dedupeKey: string;
  };
}[K];

/**
 * Records side effects inside the caller's transaction (or standalone with `null`, e.g. from the worker
 * itself). Upsert on dedupeKey keeps it idempotent.
 */
export async function enqueue(session: ClientSession | null, messages: OutboxMessage[]): Promise<void> {
  if (messages.length === 0) return;
  const now = new Date();
  await Outbox.bulkWrite(
    messages.map((m) => ({
      updateOne: {
        filter: { dedupeKey: m.dedupeKey },
        update: {
          $setOnInsert: {
            type: m.type,
            payload: m.payload as unknown as Record<string, unknown>,
            dedupeKey: m.dedupeKey,
            status: 'pending',
            attempts: 0,
            nextAttemptAt: now,
            lockedUntil: null,
            lastError: null,
            processedAt: null,
            schemaVersion: 1,
            version: 0,
            createdAt: now,
            updatedAt: now,
          },
        },
        upsert: true,
      },
    })),
    // timestamps:false: createdAt/updatedAt are set explicitly in $setOnInsert.
    { ...(session ? { session } : {}), ordered: true, timestamps: false },
  );
}
