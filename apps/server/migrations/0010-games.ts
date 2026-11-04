import type { mongo } from 'mongoose';
import type { Migration } from '../src/db/migrator';
import { applyValidators, date, jsonSchema, num, oid } from './_validators';

const VALIDATORS: Record<string, mongo.Document> = {
  snakeScores: jsonSchema(['workspaceId', 'userId', 'best', 'bestAt', 'games'], {
    workspaceId: oid,
    userId: oid,
    best: num,
    bestAt: date,
    games: num,
  }),
};

export const migration: Migration = {
  id: '0010-games',
  async up(db: mongo.Db) {
    await applyValidators(db, VALIDATORS);
  },
};
