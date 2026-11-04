/** Phase 9: dashboard and reports. zod schemas, inferred input types and DTOs for this module live here. */
import { z } from 'zod';
import { objectIdSchema } from './common';
import { dateOnlySchema } from './task';
import type { ActivityDto } from './collab';
import type { GoalStatus } from './goal';
import type { TicketSeverity, TicketType } from './ticket';
import type { StatusCategory } from '../enums';
import type { PersonRef } from '../types';

/* ------------------------------------------------------------- dashboard */

/** A task on the dashboard's "due soon" list. */
export interface DashboardTaskDto {
  id: string;
  key: string;
  title: string;
  projectId: string;
  statusCategory: StatusCategory;
  /** YYYY-MM-DD */
  dueDate: string;
  overdue: boolean;
}

export interface DashboardGoalDto {
  id: string;
  title: string;
  progressPct: number;
  status: GoalStatus;
}

/** My goals for one period (today or this week). */
export interface DashboardGoalsDto {
  /** Period key: "2026-11-03" or "2026-W45". */
  key: string;
  total: number;
  /** Achieved, or at 100% while still active. */
  achieved: number;
  /** Mean progress, 0..100 (0 when there are no goals). */
  avgProgress: number;
  /** The first few, lowest progress first. */
  items: DashboardGoalDto[];
}

/** GET /dashboard/me: the caller's own numbers. "Today" and "this week" use the workspace timezone. */
export interface MyDashboardDto {
  /** Today in the workspace timezone, YYYY-MM-DD. */
  today: string;
  /** Last day (Sunday) of the current ISO week. */
  weekEnd: string;
  tasks: {
    /** Assigned to me and not done. */
    open: number;
    todo: number;
    inProgress: number;
    testing: number;
    dueToday: number;
    /** Due from today until the end of this week (includes today). */
    dueThisWeek: number;
    overdue: number;
    /** Tasks in a testing status with me as the tester. */
    waitingForMyTesting: number;
  };
  /** Open, assigned to me. */
  openTickets: number;
  /** Overdue first, then due this week, by due date. */
  dueSoon: DashboardTaskDto[];
  goals: { today: DashboardGoalsDto; week: DashboardGoalsDto };
  /** What others did recently on tasks and tickets I'm assigned to or testing. */
  activity: ActivityDto[];
}

/* --------------------------------------------------------------- reports */

/** Longest range one report may span. */
export const REPORT_MAX_DAYS = 366;
/** Default range: the current ISO week and the seven before it. */
export const REPORT_DEFAULT_WEEKS = 8;

const DAY_MS = 86_400_000;
const daySpan = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;

/**
 * GET /reports/team. `from`/`to` are inclusive days in the workspace timezone; a missing `to` is today
 * and a missing `from` starts REPORT_DEFAULT_WEEKS weeks back (on a Monday). The server re-checks the
 * resolved range against REPORT_MAX_DAYS.
 */
export const teamReportQuerySchema = z
  .object({
    projectId: objectIdSchema.optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
  })
  .refine((v) => !v.from || !v.to || v.to >= v.from, {
    path: ['to'],
    message: 'The end date must not be before the start date',
  })
  .refine((v) => !v.from || !v.to || v.to < v.from || daySpan(v.from, v.to) <= REPORT_MAX_DAYS, {
    path: ['to'],
    message: `At most ${REPORT_MAX_DAYS} days at a time`,
  });
export type TeamReportQuery = z.infer<typeof teamReportQuerySchema>;

/** One ISO week (Monday start, workspace timezone). The first and last weeks may be partial. */
export interface ReportWeekDto {
  /** "2026-W45" */
  week: string;
  /** Monday, YYYY-MM-DD. */
  start: string;
  tasksDone: number;
  ticketsOpened: number;
  ticketsClosed: number;
  /** Weekly goals of this week (achieved / total). */
  goals: number;
  goalsAchieved: number;
}

export interface ReportAssigneeDto {
  /** null = unassigned. */
  user: PersonRef | null;
  open: number;
  inProgress: number;
  testing: number;
  overdue: number;
  /** Done within the range. */
  completed: number;
}

export interface ReportBreakdownDto<K extends string> {
  key: K;
  /** Opened within the range. */
  opened: number;
  /** Of those, still open now. */
  open: number;
}

export interface ReportGoalPeriodDto {
  total: number;
  achieved: number;
  /** achieved / total, 0..100; null without goals. */
  completionPct: number | null;
  avgProgress: number | null;
}

export interface TeamReportDto {
  /** Resolved range, inclusive days in the workspace timezone. */
  range: { from: string; to: string; timezone: string };
  /** "team" for managers and above; "self" (only the caller's own work) for everyone else. */
  scope: 'team' | 'self';
  projectId: string | null;
  tasks: {
    /** Current snapshot of every task in scope, by status category. */
    byStatus: Record<StatusCategory, number>;
    open: number;
    overdue: number;
    /** Created / done within the range. */
    created: number;
    completed: number;
    /** Mean days from creation to done, for tasks done within the range; null if none. */
    avgLeadTimeDays: number | null;
  };
  /** Open load per person, heaviest first. */
  assignees: ReportAssigneeDto[];
  weeks: ReportWeekDto[];
  tickets: {
    opened: number;
    closed: number;
    /** Open right now (any age). */
    openNow: number;
    bySeverity: ReportBreakdownDto<TicketSeverity>[];
    byType: ReportBreakdownDto<TicketType>[];
  };
  /** Goals whose period starts within the range (cancelled ones excluded). */
  goals: ReportGoalPeriodDto & {
    byPeriod: {
      daily: ReportGoalPeriodDto;
      weekly: ReportGoalPeriodDto;
      monthly: ReportGoalPeriodDto;
    };
  };
  /** Of the tasks that passed testing within the range, how many passed on the first round. */
  testing: { passed: number; passedFirstRound: number; firstPassRate: number | null };
}
