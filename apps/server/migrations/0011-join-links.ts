import type { mongo } from 'mongoose';
import type { Migration } from '../src/db/migrator';
import { applyValidators, date, dateOrNull, jsonSchema, num, oid, str } from './_validators';

const VALIDATORS: Record<string, mongo.Document> = {
  joinLinks: jsonSchema(['workspaceId', 'tokenHash', 'createdBy', 'expiresAt'], {
    workspaceId: oid,
    tokenHash: str(128),
    createdBy: oid,
    expiresAt: date,
    revokedAt: dateOrNull,
    useCount: num,
  }),
};

export const migration: Migration = {
  id: '0011-join-links',
  async up(db: mongo.Db) {
    await applyValidators(db, VALIDATORS);
  },
};
