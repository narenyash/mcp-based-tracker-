import { z } from 'zod';
import type { PersonRef } from '../types';
import type { StatusCategory } from '../enums';
import { objectIdSchema, paginationQuerySchema } from './common';
import { dateOnlySchema } from './task';

/** Phase 6: goals: zod schemas, inferred input types and DTOs for this module live here. */

export const GOAL_SCOPES = ['personal', 'team', 'project'] as const;
export type GoalScope = (typeof GOAL_SCOPES)[number];

/** Goals roll up daily -> weekly -> monthly. */
export const GOAL_PERIODS = ['daily', 'weekly', 'monthly'] as const;
export type GoalPeriod = (typeof GOAL_PERIODS)[number];

/** How progress is measured when a goal has no key results. */
export const GOAL_MEASURES = ['boolean', 'number', 'percent', 'tasks'] as const;
export type GoalMeasure = (typeof GOAL_MEASURES)[number];

/** `missed` and `carried_over` are set by the system (period rollover, carry-over), never directly. */
export const GOAL_STATUSES = ['active', 'achieved', 'missed', 'carried_over', 'cancelled'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const MAX_KEY_RESULTS = 10;
export const MAX_LINKED_TASKS = 100;
const MAX_AMOUNT = 1_000_000_000;

const title = z.string().trim().min(1, 'Title is required').max(200);
const description = z.string().max(5000);
const unit = z.string().trim().max(20);
const target = z.number().positive('Must be more than 0').max(MAX_AMOUNT);
const amount = z.number().min(0).max(MAX_AMOUNT);

export const keyResultInputSchema = z.object({
  /** Present when editing an existing key result (keeps its identity); omit for new ones. */
  id: objectIdSchema.optional(),
  title,
  target,
  current: amount.default(0),
  unit: unit.default(''),
});
export type KeyResultInput = z.infer<typeof keyResultInputSchema>;

const keyResults = z.array(keyResultInputSchema).max(MAX_KEY_RESULTS, `At most ${MAX_KEY_RESULTS} key results`);

export const createGoalSchema = z
  .object({
    title,
    description: description.default(''),
    scope: z.enum(GOAL_SCOPES).default('personal'),
    projectId: objectIdSchema.nullable().default(null),
    /** Personal goals belong to their creator; for team/project goals this is who is accountable (default: me). */
    ownerId: objectIdSchema.optional(),
    period: z.enum(GOAL_PERIODS),
    /** Any day inside the period (workspace calendar). Defaults to today in the workspace timezone. */
    date: dateOnlySchema.optional(),
    measure: z.enum(GOAL_MEASURES).default('boolean'),
    target: target.default(1),
    current: amount.default(0),
    unit: unit.default(''),
    keyResults: keyResults.default([]),
    linkedTaskIds: z.array(objectIdSchema).max(MAX_LINKED_TASKS).default([]),
    parentGoalId: objectIdSchema.nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.scope === 'project' && !v.projectId) ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'Choose a project' });
    if (v.scope !== 'project' && v.projectId) ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'Only project goals belong to a project' });
  });
export type CreateGoalInput = z.infer<typeof createGoalSchema>;

/** Scope, project and period are fixed at creation; carry a goal over to move it to another period. */
export const updateGoalSchema = z
  .object({
    title,
    description,
    ownerId: objectIdSchema,
    measure: z.enum(GOAL_MEASURES),
    target,
    unit,
    /** Replaces the whole list; items with an `id` keep their identity. */
    keyResults,
    parentGoalId: objectIdSchema.nullable(),
    status: z.enum(['active', 'cancelled']),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;

export const goalProgressSchema = z
  .object({
    current: amount,
    keyResults: z.array(z.object({ id: objectIdSchema, current: amount })).max(MAX_KEY_RESULTS),
  })
  .partial()
  .refine((v) => v.current !== undefined || (v.keyResults?.length ?? 0) > 0, 'Nothing to update');
export type GoalProgressInput = z.infer<typeof goalProgressSchema>;

export const linkGoalTaskSchema = z.object({ taskId: objectIdSchema });
export const goalTaskParamsSchema = z.object({ id: objectIdSchema, taskId: objectIdSchema });

/** `me` = my goals, `team` = everything I can see in the period, or one person's goals. */
export const goalOwnerFilterSchema = z.union([z.literal('me'), z.literal('team'), objectIdSchema]);

export const listGoalsQuerySchema = paginationQuerySchema.extend({
  period: z.enum(GOAL_PERIODS).default('weekly'),
  date: dateOnlySchema.optional(),
  owner: goalOwnerFilterSchema.default('me'),
  projectId: objectIdSchema.optional(),
  status: z.enum(GOAL_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
export type ListGoalsQuery = z.infer<typeof listGoalsQuerySchema>;

export const goalSummaryQuerySchema = z.object({
  period: z.enum(GOAL_PERIODS).default('weekly'),
  date: dateOnlySchema.optional(),
});
export type GoalSummaryQuery = z.infer<typeof goalSummaryQuerySchema>;

/* ---------------------------------------------------------------- DTOs */

/** A period on the workspace calendar. `start`/`end` are the first and last day (inclusive, YYYY-MM-DD). */
export interface GoalPeriodDto {
  period: GoalPeriod;
  /** "2026-11-01", "2026-W44" (ISO week) or "2026-11". */
  key: string;
  start: string;
  end: string;
}

export interface KeyResultDto {
  id: string;
  title: string;
  target: number;
  current: number;
  unit: string;
}

export interface GoalDto {
  id: string;
  scope: GoalScope;
  projectId: string | null;
  owner: PersonRef | null;
  period: GoalPeriod;
  periodKey: string;
  /** First and last day of the period (inclusive, workspace calendar). */
  startDate: string;
  endDate: string;
  /** Exact UTC bounds, half-open: [periodStart, periodEnd). */
  periodStart: string;
  periodEnd: string;
  title: string;
  description: string;
  measure: GoalMeasure;
  target: number;
  current: number;
  unit: string;
  keyResults: KeyResultDto[];
  linkedTaskIds: string[];
  /** Live linked tasks (deleted ones drop out). */
  tasks: { total: number; done: number };
  /** 0-100. From key results if any, else linked tasks (measure=tasks), else current/target. */
  progressPct: number;
  status: GoalStatus;
  carriedFromId: string | null;
  carriedToId: string | null;
  parentGoalId: string | null;
  /** Whether the caller may edit it (computed per request). */
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface GoalTaskSummaryDto {
  id: string;
  key: string;
  title: string;
  projectId: string;
  statusCategory: StatusCategory;
}

export interface GoalDetailDto extends GoalDto {
  /** Linked tasks the caller can see. */
  linkedTasks: GoalTaskSummaryDto[];
  /** Goals one period level down that roll up into this one. */
  children: GoalDto[];
}

export interface GoalListDto {
  items: GoalDto[];
  nextCursor: string | null;
  period: GoalPeriodDto;
}

export interface GoalSummaryRowDto {
  goals: number;
  achieved: number;
  /** Average progress, 0-100 (rounded). */
  avgProgress: number;
}

export interface GoalSummaryDto {
  period: GoalPeriodDto;
  /** Per goal owner. Managers and above see everyone; others see themselves. */
  people: (GoalSummaryRowDto & { user: PersonRef })[];
  /** Team-scope goals. */
  team: GoalSummaryRowDto;
}
