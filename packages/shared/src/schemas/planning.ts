/** Phase 8: calendar, standups, search. zod schemas, inferred input types and DTOs for this module live here. */
import { z } from 'zod';
import { objectIdSchema, paginationQuerySchema } from './common';
import { dateOnlySchema } from './task';
import type { PersonRef } from '../types';

/* Frozen contracts used by every module's search/calendar source (apps/server/src/services/discovery.ts). */

export const SEARCH_HIT_TYPES = ['task', 'ticket', 'goal', 'board', 'project', 'user'] as const;
export type SearchHitType = (typeof SEARCH_HIT_TYPES)[number];

export interface SearchHitDto {
  type: SearchHitType;
  id: string;
  /** e.g. "WEB-12 Fix footer links" or a person's name. */
  title: string;
  /** Secondary line: project name, status, email... */
  subtitle: string;
  /** In-app path that opens it. */
  path: string;
}

export interface CalendarItemDto {
  type: 'task' | 'ticket' | 'goal';
  id: string;
  key: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  path: string;
  /** Status or project colour, hex. */
  color: string;
  done: boolean;
}

/* ------------------------------------------------------------------ search */

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Type something to search').max(80),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export interface SearchGroupDto {
  type: SearchHitType;
  items: SearchHitDto[];
}

export interface SearchResponseDto {
  groups: SearchGroupDto[];
}

/* ---------------------------------------------------------------- calendar */

/** Longest range one calendar request may span (a month grid with leading/trailing weeks fits in 42 days). */
export const CALENDAR_MAX_DAYS = 62;
const DAY_MS = 86_400_000;
const daySpan = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;

export const calendarQuerySchema = z
  .object({
    from: dateOnlySchema,
    to: dateOnlySchema,
    projectId: objectIdSchema.optional(),
    mine: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .default('false'),
  })
  .refine((v) => v.to >= v.from, { path: ['to'], message: 'The end date must not be before the start date' })
  .refine((v) => v.to < v.from || daySpan(v.from, v.to) <= CALENDAR_MAX_DAYS, { path: ['to'], message: `At most ${CALENDAR_MAX_DAYS} days at a time` });
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;

export interface CalendarResponseDto {
  items: CalendarItemDto[];
}

/* ---------------------------------------------------------------- standups */

export const STANDUP_TEXT_MAX = 2000;
export const STANDUP_MAX_BLOCKER_TASKS = 10;

const standupText = z.string().trim().max(STANDUP_TEXT_MAX);

/** PUT /standups/me. `date` defaults to today in the workspace timezone; only today or yesterday can be written. */
export const upsertStandupSchema = z.object({
  date: dateOnlySchema.optional(),
  yesterday: standupText.default(''),
  today: standupText.default(''),
  blockers: standupText.default(''),
  blockerTaskIds: z.array(objectIdSchema).max(STANDUP_MAX_BLOCKER_TASKS, `At most ${STANDUP_MAX_BLOCKER_TASKS} blocking tasks`).default([]),
  mood: z.number().int().min(1).max(5).nullable().default(null),
  projectId: objectIdSchema.nullable().optional(),
});
export type UpsertStandupInput = z.infer<typeof upsertStandupSchema>;

export const standupFeedQuerySchema = z.object({
  date: dateOnlySchema.optional(),
  projectId: objectIdSchema.optional(),
});
export type StandupFeedQuery = z.infer<typeof standupFeedQuerySchema>;

export const standupHistoryQuerySchema = paginationQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type StandupHistoryQuery = z.infer<typeof standupHistoryQuerySchema>;

/** A task as referenced from a standup (blockers, suggestions). */
export interface StandupTaskRefDto {
  id: string;
  key: string;
  title: string;
  projectId: string;
}

export interface StandupDto {
  id: string;
  /** YYYY-MM-DD in the workspace timezone. */
  date: string;
  user: PersonRef;
  projectId: string | null;
  yesterday: string;
  today: string;
  blockers: string;
  /** Only the blocking tasks the viewer can see. */
  blockerTasks: StandupTaskRefDto[];
  mood: number | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface StandupFeedDto {
  /** The day shown. */
  date: string;
  /** Today in the workspace timezone (what "today" means for editing). */
  today: string;
  /** Whether the caller may still write their standup for `date` (today or yesterday). */
  editable: boolean;
  standupTime: string;
  /** True when it's a working day, past the standup time, and the caller hasn't posted today. */
  nudge: boolean;
  mine: StandupDto | null;
  entries: StandupDto[];
  notPosted: PersonRef[];
}

export interface StandupSuggestionsDto {
  /** The window "yesterday" covers: since the previous working day's midnight until today's (ISO instants). */
  since: string;
  until: string;
  completed: StandupTaskRefDto[];
  inProgress: StandupTaskRefDto[];
}
