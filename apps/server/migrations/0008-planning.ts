import type { mongo } from 'mongoose';
import type { Migration } from '../src/db/migrator';
import { applyValidators, date, jsonSchema, num, oid, oidOrNull, str } from './_validators';

const VALIDATORS: Record<string, mongo.Document> = {
  standups: jsonSchema(['workspaceId', 'userId', 'dateKey', 'date'], {
    workspaceId: oid,
    userId: oid,
    projectId: oidOrNull,
    dateKey: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    date,
    yesterday: str(2000),
    today: str(2000),
    blockers: str(2000),
    blockerTaskIds: { bsonType: 'array', maxItems: 10, items: oid },
    mood: { bsonType: ['int', 'long', 'double', 'null'], minimum: 1, maximum: 5 },
    version: { ...num, minimum: 0 },
  }),
};

/** Phase 8: daily standups (calendar and search read existing collections). */
export const migration: Migration = {
  id: '0008-planning',
  async up(db: mongo.Db) {
    await applyValidators(db, VALIDATORS);
  },
};
