import type { mongo } from 'mongoose';
import type { Migration } from '../src/db/migrator';
import { collectionName } from '../src/config/env';

/** $jsonSchema helpers: a DB-level backstop to the app's validation, so scripts can't write junk either. */
const oid = { bsonType: 'objectId' };
const oidOrNull = { bsonType: ['objectId', 'null'] };
const str = (maxLength?: number) => ({ bsonType: 'string', ...(maxLength ? { maxLength } : {}) });
const strOrNull = { bsonType: ['string', 'null'] };
const date = { bsonType: 'date' };
const dateOrNull = { bsonType: ['date', 'null'] };
const num = { bsonType: ['int', 'long', 'double', 'decimal'] };
const enumOf = (values: readonly string[]) => ({ enum: values });

function schema(required: string[], properties: Record<string, mongo.Document>): mongo.Document {
  return { $jsonSchema: { bsonType: 'object', required, properties } };
}

const VALIDATORS: Record<string, mongo.Document> = {
  workspaces: schema(['name', 'slug', 'timezone'], {
    name: str(60),
    slug: str(48),
    timezone: str(64),
    ownerId: oidOrNull,
    deletedAt: dateOrNull,
  }),
  users: schema(['workspaceId', 'email', 'name', 'role', 'status'], {
    workspaceId: oid,
    email: str(254),
    name: str(80),
    role: enumOf(['owner', 'admin', 'manager', 'member', 'guest']),
    status: enumOf(['invited', 'active', 'suspended']),
    passwordHash: strOrNull,
    failedLoginCount: num,
    lockedUntil: dateOrNull,
    deletedAt: dateOrNull,
  }),
  sessions: schema(['workspaceId', 'userId', 'familyId', 'tokenHash', 'expiresAt'], {
    workspaceId: oid,
    userId: oid,
    familyId: oid,
    tokenHash: str(64),
    expiresAt: date,
    revokedAt: dateOrNull,
    replacedBy: oidOrNull,
  }),
  invites: schema(['workspaceId', 'email', 'role', 'tokenHash', 'invitedBy', 'expiresAt'], {
    workspaceId: oid,
    email: str(254),
    role: enumOf(['admin', 'manager', 'member', 'guest']),
    tokenHash: str(64),
    invitedBy: oid,
    expiresAt: date,
    acceptedAt: dateOrNull,
    revokedAt: dateOrNull,
  }),
  projects: schema(['workspaceId', 'key', 'name', 'leadId', 'workflow'], {
    workspaceId: oid,
    key: { bsonType: 'string', pattern: '^[A-Z][A-Z0-9]{1,9}$' },
    name: str(80),
    description: str(2000),
    visibility: enumOf(['private', 'workspace']),
    status: enumOf(['active', 'archived']),
    leadId: oid,
    memberCount: { ...num, minimum: 0 },
    deletedAt: dateOrNull,
  }),
  projectMembers: schema(['workspaceId', 'projectId', 'userId', 'role'], {
    workspaceId: oid,
    projectId: oid,
    userId: oid,
    role: enumOf(['lead', 'member', 'viewer']),
  }),
  outbox: schema(['type', 'payload', 'dedupeKey', 'status', 'nextAttemptAt'], {
    type: str(64),
    payload: { bsonType: 'object' },
    dedupeKey: str(200),
    status: enumOf(['pending', 'processing', 'done', 'dead']),
    attempts: num,
    nextAttemptAt: date,
    lockedUntil: dateOrNull,
  }),
  emailLogs: schema(['to', 'template', 'subject', 'status'], {
    to: str(),
    template: str(64),
    subject: str(),
    status: enumOf(['sent', 'failed']),
  }),
  rateLimits: schema(['key', 'count', 'expiresAt'], { key: str(400), count: num, expiresAt: date }),
};

export const migration: Migration = {
  id: '0001-initial',
  async up(db: mongo.Db) {
    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    for (const [logical, validator] of Object.entries(VALIDATORS)) {
      const name = collectionName(logical);
      if (existing.has(name)) {
        await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
      } else {
        await db.createCollection(name, { validator, validationLevel: 'strict', validationAction: 'error' });
      }
    }
  },
};
