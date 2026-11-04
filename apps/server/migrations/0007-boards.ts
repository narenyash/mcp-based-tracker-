import type { mongo } from 'mongoose';
import type { Migration } from '../src/db/migrator';
import { applyValidators, date, dateOrNull, enumOf, jsonSchema, num, oid, oidOrNull, str } from './_validators';

/** Phase 7: whiteboards. Metadata and snapshot index only; scene content lives in object storage. */
const VALIDATORS: Record<string, mongo.Document> = {
  boards: jsonSchema(['workspaceId', 'projectId', 'title', 'sceneVersion', 'elementCount', 'lastEditedAt'], {
    workspaceId: oid,
    projectId: oid,
    title: str(120),
    sceneVersion: { ...num, minimum: 0 },
    currentSnapshotId: oidOrNull,
    elementCount: { ...num, minimum: 0, maximum: 20_000 },
    thumbnailKey: { bsonType: ['string', 'null'], maxLength: 512 },
    files: {
      bsonType: 'array',
      maxItems: 500,
      items: {
        bsonType: 'object',
        required: ['fileId', 'mimeType', 'sizeBytes', 'createdBy', 'createdAt'],
        properties: {
          fileId: { bsonType: 'string', pattern: '^[a-f0-9]{32}$' },
          mimeType: enumOf(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
          sizeBytes: { ...num, minimum: 1, maximum: 5 * 1024 * 1024 },
          createdBy: oid,
          createdAt: date,
        },
      },
    },
    lastEditedBy: oidOrNull,
    lastEditedAt: date,
    deletedAt: dateOrNull,
  }),
  boardSnapshots: jsonSchema(['workspaceId', 'boardId', 'sceneVersion', 'storageKey', 'sizeBytes', 'elementCount', 'reason', 'createdBy'], {
    workspaceId: oid,
    boardId: oid,
    sceneVersion: { ...num, minimum: 1 },
    storageKey: str(512),
    sizeBytes: { ...num, minimum: 1, maximum: 5 * 1024 * 1024 },
    elementCount: { ...num, minimum: 0, maximum: 20_000 },
    reason: enumOf(['autosave', 'manual', 'restore']),
    createdBy: oid,
  }),
};

export const migration: Migration = {
  id: '0007-boards',
  async up(db: mongo.Db) {
    await applyValidators(db, VALIDATORS);
  },
};
