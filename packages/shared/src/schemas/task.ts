import { z } from 'zod';
import { STATUS_CATEGORIES, TASK_PRIORITIES } from '../enums';
import { hexColorSchema, objectIdSchema, paginationQuerySchema } from './common';

export const statusIdSchema = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/, 'Invalid status');

/** Calendar date without time or zone ("2026-11-03"). */
export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Invalid date');

export const taskKeySchema = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d{1,9}$/i);

const title = z.string().trim().min(1, 'Title is required').max(200);
const description = z.string().max(20_000);

export const createTaskSchema = z.object({
  title,
  description: description.default(''),
  statusId: statusIdSchema.optional(),
  priority: z.enum(TASK_PRIORITIES).default('none'),
  assigneeId: objectIdSchema.nullable().default(null),
  testerId: objectIdSchema.nullable().default(null),
  dueDate: dateOnlySchema.nullable().default(null),
  labelIds: z.array(objectIdSchema).max(20).default([]),
  parentTaskId: objectIdSchema.nullable().default(null),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    title,
    description,
    priority: z.enum(TASK_PRIORITIES),
    assigneeId: objectIdSchema.nullable(),
    testerId: objectIdSchema.nullable(),
    dueDate: dateOnlySchema.nullable(),
    labelIds: z.array(objectIdSchema).max(20),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

/**
 * Moves a task to a status and position. Position is given by neighbour ids (never client ranks):
 * `afterId` = the card above, `beforeId` = the card below. Omit both to append to the column.
 */
export const moveTaskSchema = z.object({
  statusId: statusIdSchema,
  afterId: objectIdSchema.nullable().optional(),
  beforeId: objectIdSchema.nullable().optional(),
  /** Required when entering a testing status and the task has no tester yet. */
  testerId: objectIdSchema.optional(),
  /** Handover note to the tester, or the reason testing failed. */
  note: z.string().trim().max(2000).optional(),
});
export type MoveTaskInput = z.infer<typeof moveTaskSchema>;

const personFilter = z.union([z.literal('me'), objectIdSchema]);

export const TASK_SORTS = ['updated', 'created', 'priority'] as const;

export const listTasksQuerySchema = paginationQuerySchema.extend({
  projectId: objectIdSchema.optional(),
  parentId: objectIdSchema.optional(),
  assignee: personFilter.optional(),
  tester: personFilter.optional(),
  state: z.enum(['open', 'done', 'all']).default('all'),
  statusCategory: z.enum(STATUS_CATEGORIES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  labelId: objectIdSchema.optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(TASK_SORTS).default('updated'),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const addChecklistItemSchema = z.object({ text: z.string().trim().min(1).max(500) });

export const updateChecklistItemSchema = z
  .object({ text: z.string().trim().min(1).max(500), done: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const checklistParamsSchema = z.object({ id: objectIdSchema, itemId: objectIdSchema });

export const createLabelSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: hexColorSchema.default('#737373'),
});
export type CreateLabelInput = z.infer<typeof createLabelSchema>;

export const labelParamsSchema = z.object({ id: objectIdSchema, labelId: objectIdSchema });
