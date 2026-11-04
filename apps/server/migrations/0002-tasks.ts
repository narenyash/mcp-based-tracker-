import type { mongo } from 'mongoose';
import type { Migration } from '../src/db/migrator';
import { collectionName } from '../src/config/env';
import { applyValidators, bool, date, dateOrNull, enumOf, jsonSchema, num, oid, oidOrNull, str } from './_validators';

const CATEGORIES = ['todo', 'in_progress', 'testing', 'done'];

const VALIDATORS: Record<string, mongo.Document> = {
  tasks: jsonSchema(
    ['workspaceId', 'projectId', 'number', 'key', 'title', 'statusId', 'statusCategory', 'reporterId', 'rank'],
    {
      workspaceId: oid,
      projectId: oid,
      number: { ...num, minimum: 1 },
      key: str(21),
      title: str(200),
      description: str(20_000),
      statusId: { bsonType: 'string', pattern: '^[a-z][a-z0-9_]{1,31}$' },
      statusCategory: enumOf(CATEGORIES),
      priority: enumOf(['none', 'low', 'medium', 'high', 'urgent']),
      priorityRank: { ...num, minimum: 0, maximum: 4 },
      assigneeId: oidOrNull,
      testerId: oidOrNull,
      reporterId: oid,
      labelIds: { bsonType: 'array', maxItems: 20, items: oid },
      dueDate: dateOrNull,
      completedAt: dateOrNull,
      parentTaskId: oidOrNull,
      rank: { bsonType: 'string', pattern: '^[0-9a-z]*[1-9a-z]$', maxLength: 128 },
      checklist: {
        bsonType: 'array',
        maxItems: 100,
        items: { bsonType: 'object', required: ['_id', 'text', 'done'], properties: { _id: oid, text: str(500), done: bool } },
      },
      testing: {
        bsonType: ['object', 'null'],
        required: ['round', 'result', 'sentAt', 'sentBy'],
        properties: { round: { ...num, minimum: 1 }, result: enumOf(['pending', 'passed', 'failed']), sentAt: date, sentBy: oid },
      },
      deletedAt: dateOrNull,
    },
  ),
  labels: jsonSchema(['workspaceId', 'projectId', 'name', 'color'], {
    workspaceId: oid,
    projectId: oid,
    name: str(40),
    color: { bsonType: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
  }),
  counters: jsonSchema(['_id', 'workspaceId', 'seq'], { _id: str(64), workspaceId: oid, seq: { ...num, minimum: 0 } }),
};

interface WorkflowStatus {
  id: string;
  name: string;
  category: string;
  color: string;
  order: number;
}

/** Inserts a Testing status before the first done status in workflows that have none. */
export function withTestingStatus(statuses: WorkflowStatus[]): WorkflowStatus[] | null {
  if (statuses.some((s) => s.category === 'testing')) return null;
  const ids = new Set(statuses.map((s) => s.id));
  const id = ids.has('testing') ? 'testing_qa' : 'testing';
  const sorted = [...statuses].sort((a, b) => a.order - b.order);
  const doneAt = sorted.findIndex((s) => s.category === 'done');
  const testing = { id, name: 'Testing', category: 'testing', color: '#f59e0b', order: 0 };
  sorted.splice(doneAt === -1 ? sorted.length : doneAt, 0, testing);
  return sorted.slice(0, 12).map((s, i) => ({ ...s, order: i }));
}

export const migration: Migration = {
  id: '0002-tasks',
  async up(db: mongo.Db) {
    await applyValidators(db, VALIDATORS);

    const projects = db.collection<{ workflow: { taskStatuses: WorkflowStatus[] } }>(collectionName('projects'));
    const ops: mongo.AnyBulkWriteOperation<{ workflow: { taskStatuses: WorkflowStatus[] } }>[] = [];
    for await (const p of projects.find({}, { projection: { 'workflow.taskStatuses': 1 } })) {
      const next = withTestingStatus(p.workflow.taskStatuses);
      if (next) ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: { 'workflow.taskStatuses': next }, $inc: { version: 1 } } } });
    }
    if (ops.length) await projects.bulkWrite(ops, { ordered: false });
  },
};
