import mongoose from 'mongoose';
import type { mongo } from 'mongoose';
type Db = mongo.Db;
import { ALL_MODELS } from '../models';
import { MIGRATIONS } from '../../migrations';
import { logger } from '../observability/logger';
import { collectionName } from '../config/env';

export interface Migration {
  id: string;
  up(db: Db): Promise<void>;
}

const COLLECTION = collectionName('migrations');
const LOCK_ID = '__lock__';

function db(): Db {
  const d = mongoose.connection.db;
  if (!d) throw new Error('Not connected to MongoDB');
  return d as unknown as Db;
}

export async function pendingMigrations(): Promise<string[]> {
  const applied = new Set(
    (await db().collection<{ _id: string }>(COLLECTION).find({ _id: { $ne: LOCK_ID } }).toArray()).map((d) => d._id),
  );
  return MIGRATIONS.filter((m) => !applied.has(m.id)).map((m) => m.id);
}

/**
 * Applies pending migrations in order under a lock (so two deploys can't race), then
 * syncs indexes declared on the Mongoose schemas, which are the single source of truth for indexes.
 */
export async function runMigrations(): Promise<string[]> {
  const col = db().collection<{ _id: string; appliedAt?: Date; lockedAt?: Date }>(COLLECTION);
  try {
    await col.insertOne({ _id: LOCK_ID, lockedAt: new Date() });
  } catch {
    throw new Error('Another migration run holds the lock (delete the __lock__ doc if it is stale)');
  }

  const ran: string[] = [];
  try {
    const pending = new Set(await pendingMigrations());
    for (const m of MIGRATIONS) {
      if (!pending.has(m.id)) continue;
      logger.info({ migration: m.id }, 'applying migration');
      await m.up(db());
      await col.insertOne({ _id: m.id, appliedAt: new Date() });
      ran.push(m.id);
    }
    for (const model of ALL_MODELS) {
      await (model as unknown as mongoose.Model<unknown>).syncIndexes();
    }
  } finally {
    await col.deleteOne({ _id: LOCK_ID });
  }
  return ran;
}
