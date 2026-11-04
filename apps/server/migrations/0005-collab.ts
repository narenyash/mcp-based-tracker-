import type { mongo } from 'mongoose';
import type { Migration } from '../src/db/migrator';
import { applyValidators, date, dateOrNull, enumOf, jsonSchema, num, oid, oidOrNull, str } from './_validators';

const ENTITY_TYPES = ['task', 'ticket', 'goal', 'board'];
const MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/csv'];

const VALIDATORS: Record<string, mongo.Document> = {
  comments: jsonSchema(['workspaceId', 'entityType', 'entityId', 'authorId', 'body'], {
    workspaceId: oid,
    projectId: oidOrNull,
    entityType: enumOf(ENTITY_TYPES),
    entityId: oid,
    parentId: oidOrNull,
    authorId: oid,
    body: str(10_000),
    mentionUserIds: { bsonType: 'array', maxItems: 50, items: oid },
    replyCount: { ...num, minimum: 0 },
    editedAt: dateOrNull,
    deletedAt: dateOrNull,
  }),
  attachments: jsonSchema(['workspaceId', 'entityType', 'entityId', 'uploaderId', 'storageKey', 'fileName', 'mimeType', 'sizeBytes', 'checksumSha256'], {
    workspaceId: oid,
    projectId: oidOrNull,
    entityType: enumOf(ENTITY_TYPES),
    entityId: oid,
    uploaderId: oid,
    storageKey: str(600),
    fileName: str(200),
    mimeType: enumOf(MIME_TYPES),
    sizeBytes: { ...num, minimum: 1, maximum: 10 * 1024 * 1024 },
    checksumSha256: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
    image: {
      bsonType: ['object', 'null'],
      required: ['width', 'height'],
      properties: { width: { ...num, minimum: 1 }, height: { ...num, minimum: 1 } },
    },
    deletedAt: dateOrNull,
  }),
  activities: jsonSchema(['workspaceId', 'entityType', 'entityId', 'entityKey', 'actorId', 'action', 'at'], {
    workspaceId: oid,
    projectId: oidOrNull,
    entityType: enumOf(ENTITY_TYPES),
    entityId: oid,
    entityKey: str(80),
    actorId: oid,
    action: { bsonType: 'string', pattern: '^[a-z][a-z0-9_]{1,39}$' },
    changes: {
      bsonType: 'array',
      maxItems: 50,
      items: {
        bsonType: 'object',
        required: ['field'],
        properties: { field: str(40), from: { bsonType: ['string', 'null'], maxLength: 300 }, to: { bsonType: ['string', 'null'], maxLength: 300 } },
      },
    },
    at: date,
  }),
};

/** Comments, attachments and the append-only activity log. Indexes (incl. the activity TTL) come from the models. */
export const migration: Migration = {
  id: '0005-collab',
  async up(db: mongo.Db) {
    await applyValidators(db, VALIDATORS);
  },
};
