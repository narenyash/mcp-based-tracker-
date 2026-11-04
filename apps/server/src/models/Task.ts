import { model, Schema, type Types } from 'mongoose';
import {
  STATUS_CATEGORIES,
  TASK_PRIORITIES,
  TEST_RESULTS,
  type StatusCategory,
  type TaskPriority,
  type TestResult,
} from '@teamtrack/shared';
import { createSchema } from '../db/schema';
import { MAX_RANK_LENGTH, RANK_PATTERN } from '../db/rank';

export const MAX_CHECKLIST_ITEMS = 100;

export interface IChecklistItem {
  _id: Types.ObjectId;
  text: string;
  done: boolean;
  doneBy: Types.ObjectId | null;
  doneAt: Date | null;
}

/** State of the current (or last) trip through a testing status. */
export interface ITestingState {
  round: number;
  result: TestResult;
  sentAt: Date;
  sentBy: Types.ObjectId;
  resultAt: Date | null;
  resultBy: Types.ObjectId | null;
  note: string;
}

export interface ITask {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId;
  number: number;
  key: string;
  title: string;
  description: string;
  statusId: string;
  /** Denormalised from the project workflow; always derived server-side. */
  statusCategory: StatusCategory;
  priority: TaskPriority;
  priorityRank: number;
  assigneeId: Types.ObjectId | null;
  testerId: Types.ObjectId | null;
  reporterId: Types.ObjectId;
  labelIds: Types.ObjectId[];
  dueDate: Date | null;
  completedAt: Date | null;
  parentTaskId: Types.ObjectId | null;
  rank: string;
  checklist: IChecklistItem[];
  counts: { subtasks: number; subtasksDone: number };
  testing: ITestingState | null;
  /** The due date each reminder was last sent for; changing the due date re-arms both. */
  reminders: { dueSoonFor: Date | null; overdueFor: Date | null };
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const checklistItem = new Schema<IChecklistItem>(
  {
    text: { type: String, required: true, trim: true, maxlength: 500 },
    done: { type: Boolean, default: false },
    doneBy: { type: Schema.Types.ObjectId, default: null },
    doneAt: { type: Date, default: null },
  },
  { strict: 'throw' },
);

const testingState = new Schema<ITestingState>(
  {
    round: { type: Number, required: true, min: 1 },
    result: { type: String, enum: TEST_RESULTS, required: true },
    sentAt: { type: Date, required: true },
    sentBy: { type: Schema.Types.ObjectId, required: true },
    resultAt: { type: Date, default: null },
    resultBy: { type: Schema.Types.ObjectId, default: null },
    note: { type: String, default: '', maxlength: 2000 },
  },
  { _id: false, strict: 'throw' },
);

const schema = createSchema<ITask>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, immutable: true },
    number: { type: Number, required: true, min: 1, immutable: true },
    key: { type: String, required: true, immutable: true, maxlength: 21 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 20_000 },
    statusId: { type: String, required: true, match: /^[a-z][a-z0-9_]{1,31}$/ },
    statusCategory: { type: String, enum: STATUS_CATEGORIES, required: true },
    priority: { type: String, enum: TASK_PRIORITIES, default: 'none' },
    priorityRank: { type: Number, default: 0, min: 0, max: 4 },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    testerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    labelIds: {
      type: [Schema.Types.ObjectId],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= 20, message: 'At most 20 labels' },
    },
    dueDate: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    parentTaskId: { type: Schema.Types.ObjectId, ref: 'Task', default: null, immutable: true },
    rank: { type: String, required: true, match: RANK_PATTERN, maxlength: MAX_RANK_LENGTH },
    checklist: {
      type: [checklistItem],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= MAX_CHECKLIST_ITEMS, message: `At most ${MAX_CHECKLIST_ITEMS} checklist items` },
    },
    counts: {
      subtasks: { type: Number, default: 0, min: 0 },
      subtasksDone: { type: Number, default: 0, min: 0 },
    },
    testing: { type: testingState, default: null },
    reminders: {
      dueSoonFor: { type: Date, default: null },
      overdueFor: { type: Date, default: null },
    },
  },
  { collection: 'tasks', softDelete: true, tenant: true },
);

// Readable keys: numbers are never reused, even after deletion, so no partial filter.
schema.index({ workspaceId: 1, projectId: 1, number: 1 }, { unique: true });
// Board: one column, in order.
schema.index({ workspaceId: 1, projectId: 1, parentTaskId: 1, statusId: 1, rank: 1 });
// Project list views.
schema.index({ workspaceId: 1, projectId: 1, updatedAt: -1, _id: -1 });
// My work / waiting for my testing.
schema.index({ workspaceId: 1, assigneeId: 1, statusCategory: 1, updatedAt: -1 });
schema.index({ workspaceId: 1, testerId: 1, statusCategory: 1, updatedAt: -1 });
// Subtasks of a task.
schema.index({ workspaceId: 1, parentTaskId: 1, rank: 1 }, { partialFilterExpression: { parentTaskId: { $type: 'objectId' } } });
// Due-date reminders: only assigned, live tasks with a due date.
schema.index(
  { workspaceId: 1, dueDate: 1 },
  { partialFilterExpression: { assigneeId: { $type: 'objectId' }, dueDate: { $type: 'date' }, deletedAt: null } },
);
// Label filter and label deletion.
schema.index({ workspaceId: 1, labelIds: 1 });

export const Task = model<ITask>('Task', schema);
