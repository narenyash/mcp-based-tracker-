import type { mongo } from 'mongoose';
import type { Migration } from '../src/db/migrator';
import { applyValidators, dateOrNull, enumOf, jsonSchema, num, oid, oidOrNull, str } from './_validators';

const CATEGORIES = ['todo', 'in_progress', 'testing', 'done'];
const envValue = { bsonType: 'string', maxLength: 300 };

const VALIDATORS: Record<string, mongo.Document> = {
  tickets: jsonSchema(
    ['workspaceId', 'projectId', 'number', 'key', 'title', 'type', 'severity', 'severityRank', 'statusId', 'statusCategory', 'reporterId', 'rank'],
    {
      workspaceId: oid,
      projectId: oid,
      number: { ...num, minimum: 1 },
      key: { bsonType: 'string', pattern: '^TCK-[0-9]{1,9}$' },
      title: str(200),
      description: str(20_000),
      type: enumOf(['bug', 'issue', 'request', 'question', 'incident']),
      severity: enumOf(['low', 'medium', 'high', 'critical']),
      severityRank: { ...num, minimum: 1, maximum: 4 },
      statusId: { bsonType: 'string', pattern: '^[a-z][a-z0-9_]{1,31}$' },
      statusCategory: enumOf(CATEGORIES),
      assigneeId: oidOrNull,
      reporterId: oid,
      environment: {
        bsonType: 'object',
        properties: { browser: envValue, os: envValue, url: str(2000), version: envValue },
      },
      stepsToReproduce: str(5_000),
      expected: str(5_000),
      actual: str(5_000),
      resolution: { enum: ['fixed', 'wont_fix', 'duplicate', 'cannot_reproduce', 'by_design', null] },
      duplicateOfId: oidOrNull,
      resolvedAt: dateOrNull,
      resolvedBy: oidOrNull,
      reopenCount: { ...num, minimum: 0 },
      labelIds: { bsonType: 'array', maxItems: 20, items: oid },
      linkedTaskIds: { bsonType: 'array', maxItems: 50, items: oid },
      rank: { bsonType: 'string', pattern: '^[0-9a-z]*[1-9a-z]$', maxLength: 128 },
      deletedAt: dateOrNull,
    },
  ),
};

/** Phase 4: tickets collection with its $jsonSchema validator (indexes come from the model). */
export const migration: Migration = {
  id: '0004-tickets',
  async up(db: mongo.Db) {
    await applyValidators(db, VALIDATORS);
  },
};
