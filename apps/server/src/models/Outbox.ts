import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '../db/schema';

export const OUTBOX_TYPES = ['email.send', 'notify'] as const;
export type OutboxType = (typeof OUTBOX_TYPES)[number];
export const OUTBOX_STATUSES = ['pending', 'processing', 'done', 'dead'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/**
 * Transactional outbox: side effects are recorded in the same transaction as the business write
 * and executed by the outbox worker, so they happen exactly when (and only if) the write commits.
 */
export interface IOutbox {
  _id: Types.ObjectId;
  type: OutboxType;
  payload: Record<string, unknown>;
  dedupeKey: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil: Date | null;
  lastError: string | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const schema = createSchema<IOutbox>(
  {
    type: { type: String, enum: OUTBOX_TYPES, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    dedupeKey: { type: String, required: true, maxlength: 200 },
    status: { type: String, enum: OUTBOX_STATUSES, default: 'pending' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    lockedUntil: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 2000 },
    processedAt: { type: Date, default: null },
  },
  { collection: 'outbox', audit: false },
);

schema.index({ dedupeKey: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1 });
schema.index(
  { processedAt: 1 },
  { expireAfterSeconds: 14 * 24 * 3600, partialFilterExpression: { status: 'done' } },
);

export const Outbox = model<IOutbox>('Outbox', schema);
