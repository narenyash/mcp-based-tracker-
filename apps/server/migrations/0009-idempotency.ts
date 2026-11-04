import type { mongo } from 'mongoose';
import type { Migration } from '../src/db/migrator';
import { applyValidators, date, enumOf, jsonSchema, oid, str } from './_validators';

const VALIDATORS: Record<string, mongo.Document> = {
  idempotencyKeys: jsonSchema(['key', 'userId', 'method', 'path', 'requestHash', 'state', 'expiresAt'], {
    key: str(300),
    userId: oid,
    method: str(10),
    path: str(500),
    requestHash: str(64),
    state: enumOf(['processing', 'done']),
    responseStatus: { bsonType: ['int', 'long', 'double', 'null'] },
    expiresAt: date,
  }),
};

export const migration: Migration = {
  id: '0009-idempotency',
  async up(db: mongo.Db) {
    await applyValidators(db, VALIDATORS);
  },
};
