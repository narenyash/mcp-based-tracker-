import { model, Schema, type Types } from 'mongoose';
import {
  GOAL_MEASURES,
  GOAL_PERIODS,
  GOAL_SCOPES,
  GOAL_STATUSES,
  MAX_KEY_RESULTS,
  MAX_LINKED_TASKS,
  type GoalMeasure,
  type GoalPeriod,
  type GoalScope,
  type GoalStatus,
} from '@teamtrack/shared';
import { createSchema } from '../db/schema';

export const PERIOD_KEY_PATTERN = /^\d{4}-(\d{2}-\d{2}|W\d{2}|\d{2})$/;

export interface IKeyResult {
  _id: Types.ObjectId;
  title: string;
  target: number;
  current: number;
  unit: string;
}

export interface IGoal {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  /** Set for project goals only. */
  projectId: Types.ObjectId | null;
  scope: GoalScope;
  /** Personal goals: the person. Team/project goals: who is accountable. */
  ownerId: Types.ObjectId;
  period: GoalPeriod;
  periodKey: string;
  /** UTC bounds of the period in the workspace timezone, half-open. */
  periodStart: Date;
  periodEnd: Date;
  title: string;
  description: string;
  measure: GoalMeasure;
  target: number;
  current: number;
  unit: string;
  keyResults: IKeyResult[];
  linkedTaskIds: Types.ObjectId[];
  /** Live linked tasks; derived from the tasks collection, refreshed on task changes. */
  tasks: { total: number; done: number };
  /** Derived and stored so lists can sort and aggregate by it. */
  progressPct: number;
  status: GoalStatus;
  /** When the goal reached a final status (achieved, missed, carried over, cancelled). */
  closedAt: Date | null;
  carriedFromId: Types.ObjectId | null;
  carriedToId: Types.ObjectId | null;
  parentGoalId: Types.ObjectId | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const amount = { type: Number, min: 0, max: 1_000_000_000 };

const keyResult = new Schema<IKeyResult>(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    target: { ...amount, required: true },
    current: { ...amount, default: 0 },
    unit: { type: String, default: '', trim: true, maxlength: 20 },
  },
  { strict: 'throw' },
);

const schema = createSchema<IGoal>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, immutable: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null, immutable: true },
    scope: { type: String, enum: GOAL_SCOPES, required: true, immutable: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    period: { type: String, enum: GOAL_PERIODS, required: true, immutable: true },
    periodKey: { type: String, required: true, match: PERIOD_KEY_PATTERN, immutable: true },
    periodStart: { type: Date, required: true, immutable: true },
    periodEnd: { type: Date, required: true, immutable: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 5000 },
    measure: { type: String, enum: GOAL_MEASURES, required: true },
    target: { ...amount, required: true },
    current: { ...amount, default: 0 },
    unit: { type: String, default: '', trim: true, maxlength: 20 },
    keyResults: {
      type: [keyResult],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= MAX_KEY_RESULTS, message: `At most ${MAX_KEY_RESULTS} key results` },
    },
    linkedTaskIds: {
      type: [Schema.Types.ObjectId],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= MAX_LINKED_TASKS, message: `At most ${MAX_LINKED_TASKS} linked tasks` },
    },
    tasks: {
      total: { type: Number, default: 0, min: 0 },
      done: { type: Number, default: 0, min: 0 },
    },
    progressPct: { type: Number, default: 0, min: 0, max: 100 },
    status: { type: String, enum: GOAL_STATUSES, default: 'active' },
    closedAt: { type: Date, default: null },
    carriedFromId: { type: Schema.Types.ObjectId, ref: 'Goal', default: null, immutable: true },
    carriedToId: { type: Schema.Types.ObjectId, ref: 'Goal', default: null },
    parentGoalId: { type: Schema.Types.ObjectId, ref: 'Goal', default: null },
  },
  { collection: 'goals', softDelete: true, tenant: true },
);

// A period's goals, by owner (Mine / one person) and in creation order (Team).
schema.index({ workspaceId: 1, period: 1, periodKey: 1, ownerId: 1, createdAt: 1, _id: 1 });
schema.index({ workspaceId: 1, period: 1, periodKey: 1, createdAt: 1, _id: 1 });
// Project goals.
schema.index({ workspaceId: 1, projectId: 1, period: 1, periodKey: 1 }, { partialFilterExpression: { projectId: { $type: 'objectId' } } });
// Recompute progress when a linked task changes.
schema.index({ workspaceId: 1, linkedTaskIds: 1 });
// Roll-up children of a goal.
schema.index({ workspaceId: 1, parentGoalId: 1 }, { partialFilterExpression: { parentGoalId: { $type: 'objectId' } } });
// Period rollover: active goals whose period has ended.
schema.index({ workspaceId: 1, status: 1, periodEnd: 1 });
// Calendar: goals ending in a date range.
schema.index({ workspaceId: 1, periodEnd: 1 });

export const Goal = model<IGoal>('Goal', schema);
