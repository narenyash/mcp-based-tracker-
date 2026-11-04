import type { mongo } from 'mongoose';
import type { Migration } from '../src/db/migrator';
import { applyValidators, dateOrNull, date, enumOf, jsonSchema, num, oid, oidOrNull, str } from './_validators';

const amount = { ...num, minimum: 0, maximum: 1_000_000_000 };

const VALIDATORS: Record<string, mongo.Document> = {
  goals: jsonSchema(
    ['workspaceId', 'scope', 'ownerId', 'period', 'periodKey', 'periodStart', 'periodEnd', 'title', 'measure', 'target', 'status'],
    {
      workspaceId: oid,
      projectId: oidOrNull,
      scope: enumOf(['personal', 'team', 'project']),
      ownerId: oid,
      period: enumOf(['daily', 'weekly', 'monthly']),
      periodKey: { bsonType: 'string', pattern: '^\\d{4}-(\\d{2}-\\d{2}|W\\d{2}|\\d{2})$' },
      periodStart: date,
      periodEnd: date,
      title: str(200),
      description: str(5000),
      measure: enumOf(['boolean', 'number', 'percent', 'tasks']),
      target: amount,
      current: amount,
      unit: str(20),
      keyResults: {
        bsonType: 'array',
        maxItems: 10,
        items: {
          bsonType: 'object',
          required: ['_id', 'title', 'target', 'current'],
          properties: { _id: oid, title: str(200), target: amount, current: amount, unit: str(20) },
        },
      },
      linkedTaskIds: { bsonType: 'array', maxItems: 100, items: oid },
      progressPct: { ...num, minimum: 0, maximum: 100 },
      status: enumOf(['active', 'achieved', 'missed', 'carried_over', 'cancelled']),
      closedAt: dateOrNull,
      carriedFromId: oidOrNull,
      carriedToId: oidOrNull,
      parentGoalId: oidOrNull,
      deletedAt: dateOrNull,
    },
  ),
};

/** Phase 6: daily / weekly / monthly goals, progress, carry-over, rollover. */
export const migration: Migration = {
  id: '0006-goals',
  async up(db: mongo.Db) {
    await applyValidators(db, VALIDATORS);
  },
};
