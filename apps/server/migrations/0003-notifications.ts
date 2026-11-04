import type { mongo } from 'mongoose';
import { ENTITY_TYPES, NOTIFICATION_TYPES } from '@teamtrack/shared';
import type { Migration } from '../src/db/migrator';
import { applyValidators, date, dateOrNull, enumOf, jsonSchema, oid, oidOrNull, str } from './_validators';

const VALIDATORS: Record<string, mongo.Document> = {
  notifications: jsonSchema(['workspaceId', 'userId', 'type', 'title', 'path', 'sourceKey'], {
    workspaceId: oid,
    userId: oid,
    type: enumOf(NOTIFICATION_TYPES),
    projectId: oidOrNull,
    entityType: { enum: [...ENTITY_TYPES, null] },
    entityId: oidOrNull,
    title: str(300),
    body: str(300),
    note: str(2000),
    path: str(300),
    sourceKey: str(200),
    readAt: dateOrNull,
  }),
  jobLocks: jsonSchema(['_id', 'nextRunAt'], { _id: str(64), nextRunAt: date, lockedUntil: dateOrNull }),
};

export const migration: Migration = {
  id: '0003-notifications',
  async up(db: mongo.Db) {
    await applyValidators(db, VALIDATORS);
  },
};
