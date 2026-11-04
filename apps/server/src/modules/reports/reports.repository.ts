import type { FilterQuery, PipelineStage, Types } from 'mongoose';
import type { GoalPeriod, StatusCategory, TicketSeverity, TicketType } from '@teamtrack/shared';
import { Activity, type IActivity } from '../../models/Activity';
import { Goal, type IGoal } from '../../models/Goal';
import { Task, type ITask } from '../../models/Task';
import { Ticket, type ITicket } from '../../models/Ticket';

/*
 * Read-only aggregations for the dashboard and reports. Every pipeline starts with a $match on
 * workspaceId (the tenant guard checks it, and every index on these collections starts with it).
 * Soft-deleted rows are excluded explicitly (`deletedAt: null` + withDeleted) so workspaceId stays in
 * the first $match instead of the soft-delete hook prepending its own.
 *
 * Scope arguments: `projectIds: null` = every project (admins); `person` set = only that person's work.
 */

/** Reports scan a workspace's tasks; cut a pathological query off instead of letting it pile up. */
const MAX_TIME_MS = 10_000;
/** Rows of per-person load; a team is far below this. */
const ASSIGNEE_CAP = 500;
const DUE_SOON_LIMIT = 10;

/** Aggregate options: deletedAt is matched explicitly (see above), and a time budget. */
const OPTIONS = { withDeleted: true, maxTimeMS: MAX_TIME_MS } as never;

export interface ReportScope {
  workspaceId: Types.ObjectId;
  projectIds: Types.ObjectId[] | null;
  person: Types.ObjectId | null;
}

export interface ReportWindow {
  /** Half-open [start, end) instants of the range in the workspace timezone. */
  start: Date;
  end: Date;
  /** Today's date key as a Date (due dates are stored at 00:00 UTC of their day). */
  today: Date;
  timezone: string;
}

const inProjects = (projectIds: Types.ObjectId[] | null) =>
  projectIds ? { projectId: { $in: projectIds } } : {};
/** ISO week key ("2026-W45") of a date field in the workspace timezone; matches goals/period.ts isoWeek. */
const weekOf = (field: string, timezone: string) => ({
  $dateToString: { date: field, format: '%G-W%V', timezone },
});
const count = (cond: unknown) => ({ $sum: { $cond: [cond, 1, 0] } });
const between = (field: string, w: ReportWindow) => ({ [field]: { $gte: w.start, $lt: w.end } });

/** A goal counts as achieved once closed as achieved, or while still active at 100%. */
const ACHIEVED = {
  $or: [
    { $eq: ['$status', 'achieved'] },
    { $and: [{ $eq: ['$status', 'active'] }, { $gte: ['$progressPct', 100] }] },
  ],
};

export interface Bucket {
  _id: string;
  n: number;
}

export interface TaskReportRaw {
  byStatus: { _id: StatusCategory; n: number }[];
  load: {
    _id: Types.ObjectId | null;
    open: number;
    inProgress: number;
    testing: number;
    overdue: number;
  }[];
  completedBy: { _id: Types.ObjectId | null; n: number }[];
  completedWeeks: Bucket[];
  completed: { n: number; leadMs: number }[];
  created: { n: number }[];
  testing: { passed: number; firstRound: number }[];
}

export interface TicketReportRaw {
  openedWeeks: Bucket[];
  closedWeeks: Bucket[];
  bySeverity: { _id: TicketSeverity; opened: number; open: number }[];
  byType: { _id: TicketType; opened: number; open: number }[];
  openNow: { n: number }[];
}

export interface GoalTotalsRaw {
  _id: GoalPeriod | string | null;
  total: number;
  achieved: number;
  progress: number;
}

export interface GoalReportRaw {
  byPeriod: GoalTotalsRaw[];
  weeks: GoalTotalsRaw[];
}

export interface MyTaskStatsRaw {
  byStatus: { _id: StatusCategory; n: number }[];
  dueToday: { n: number }[];
  dueThisWeek: { n: number }[];
  overdue: { n: number }[];
  dueSoon: Pick<ITask, '_id' | 'key' | 'title' | 'projectId' | 'statusCategory' | 'dueDate'>[];
}

export type MyGoal = Pick<IGoal, '_id' | 'title' | 'period' | 'progressPct' | 'status'>;

export const reportsRepository = {
  /* ---------------------------------------------------------------- team report */

  async taskReport(scope: ReportScope, w: ReportWindow): Promise<TaskReportRaw> {
    const match: FilterQuery<ITask> = {
      workspaceId: scope.workspaceId,
      deletedAt: null,
      ...inProjects(scope.projectIds),
    };
    if (scope.person) match.assigneeId = scope.person;
    const doneInRange = { statusCategory: 'done', ...between('completedAt', w) };
    const pipeline: PipelineStage[] = [
      { $match: match },
      {
        $facet: {
          byStatus: [{ $group: { _id: '$statusCategory', n: { $sum: 1 } } }],
          load: [
            { $match: { statusCategory: { $ne: 'done' } } },
            {
              $group: {
                _id: '$assigneeId',
                open: { $sum: 1 },
                inProgress: count({ $eq: ['$statusCategory', 'in_progress'] }),
                testing: count({ $eq: ['$statusCategory', 'testing'] }),
                // In expressions null sorts before every date, so check the type before comparing.
                overdue: count({
                  $and: [{ $eq: [{ $type: '$dueDate' }, 'date'] }, { $lt: ['$dueDate', w.today] }],
                }),
              },
            },
            { $limit: ASSIGNEE_CAP },
          ],
          completedBy: [
            { $match: doneInRange },
            { $group: { _id: '$assigneeId', n: { $sum: 1 } } },
            { $limit: ASSIGNEE_CAP },
          ],
          completedWeeks: [
            { $match: doneInRange },
            { $group: { _id: weekOf('$completedAt', w.timezone), n: { $sum: 1 } } },
          ],
          completed: [
            { $match: doneInRange },
            {
              $group: {
                _id: null,
                n: { $sum: 1 },
                leadMs: { $sum: { $subtract: ['$completedAt', '$createdAt'] } },
              },
            },
          ],
          created: [{ $match: between('createdAt', w) }, { $count: 'n' }],
          testing: [
            { $match: { 'testing.result': 'passed', ...between('testing.resultAt', w) } },
            {
              $group: {
                _id: null,
                passed: { $sum: 1 },
                firstRound: count({ $eq: ['$testing.round', 1] }),
              },
            },
          ],
        },
      },
    ];
    const [out] = await Task.aggregate<TaskReportRaw>(pipeline).option(OPTIONS);
    return out!;
  },

  async ticketReport(scope: ReportScope, w: ReportWindow): Promise<TicketReportRaw> {
    const match: FilterQuery<ITicket> = {
      workspaceId: scope.workspaceId,
      deletedAt: null,
      ...inProjects(scope.projectIds),
    };
    // A person's tickets: the ones they work on or raised.
    if (scope.person) match.$or = [{ assigneeId: scope.person }, { reporterId: scope.person }];
    const stillOpen = count({ $ne: ['$statusCategory', 'done'] });
    const pipeline: PipelineStage[] = [
      { $match: match },
      {
        $facet: {
          openedWeeks: [
            { $match: between('createdAt', w) },
            { $group: { _id: weekOf('$createdAt', w.timezone), n: { $sum: 1 } } },
          ],
          // resolvedAt is cleared on reopen, so this counts tickets closed in the range and still closed.
          closedWeeks: [
            { $match: between('resolvedAt', w) },
            { $group: { _id: weekOf('$resolvedAt', w.timezone), n: { $sum: 1 } } },
          ],
          bySeverity: [
            { $match: between('createdAt', w) },
            { $group: { _id: '$severity', opened: { $sum: 1 }, open: stillOpen } },
          ],
          byType: [
            { $match: between('createdAt', w) },
            { $group: { _id: '$type', opened: { $sum: 1 }, open: stillOpen } },
          ],
          openNow: [{ $match: { statusCategory: { $ne: 'done' } } }, { $count: 'n' }],
        },
      },
    ];
    const [out] = await Ticket.aggregate<TicketReportRaw>(pipeline).option(OPTIONS);
    return out!;
  },

  /** `visible` is the goal-visibility filter for the viewer (empty for admins). */
  async goalReport(
    scope: ReportScope,
    w: ReportWindow,
    visible: FilterQuery<IGoal>,
    projectId: Types.ObjectId | null,
  ): Promise<GoalReportRaw> {
    const match: FilterQuery<IGoal> = {
      workspaceId: scope.workspaceId,
      deletedAt: null,
      // periodEnd bound uses the { workspaceId, periodEnd } index; the start must also fall inside the range.
      periodEnd: { $gt: w.start },
      periodStart: { $gte: w.start, $lt: w.end },
      status: { $ne: 'cancelled' },
    };
    const and: FilterQuery<IGoal>[] = [];
    if (visible.$or) and.push(visible);
    if (projectId) Object.assign(match, { scope: 'project', projectId });
    if (scope.person) match.ownerId = scope.person;
    if (and.length) match.$and = and;
    const totals = {
      total: { $sum: 1 },
      achieved: count(ACHIEVED),
      progress: { $sum: '$progressPct' },
    };
    const pipeline: PipelineStage[] = [
      { $match: match },
      {
        $facet: {
          byPeriod: [{ $group: { _id: '$period', ...totals } }],
          weeks: [{ $match: { period: 'weekly' } }, { $group: { _id: '$periodKey', ...totals } }],
        },
      },
    ];
    const [out] = await Goal.aggregate<GoalReportRaw>(pipeline).option(OPTIONS);
    return out!;
  },

  /* ------------------------------------------------------------------ dashboard */

  /** My open tasks: counts by category and due-date bucket, plus the next few due. */
  async myTaskStats(
    workspaceId: Types.ObjectId,
    userId: Types.ObjectId,
    projectIds: Types.ObjectId[] | null,
    today: Date,
    weekEnd: Date,
  ): Promise<MyTaskStatsRaw> {
    const pipeline: PipelineStage[] = [
      // Served by { workspaceId, assigneeId, statusCategory, updatedAt }.
      {
        $match: {
          workspaceId,
          assigneeId: userId,
          statusCategory: { $ne: 'done' },
          deletedAt: null,
          ...inProjects(projectIds),
        },
      },
      {
        $facet: {
          byStatus: [{ $group: { _id: '$statusCategory', n: { $sum: 1 } } }],
          dueToday: [{ $match: { dueDate: today } }, { $count: 'n' }],
          dueThisWeek: [{ $match: { dueDate: { $gte: today, $lte: weekEnd } } }, { $count: 'n' }],
          overdue: [{ $match: { dueDate: { $lt: today } } }, { $count: 'n' }],
          dueSoon: [
            { $match: { dueDate: { $type: 'date', $lte: weekEnd } } },
            { $sort: { dueDate: 1, _id: 1 } },
            { $limit: DUE_SOON_LIMIT },
            { $project: { _id: 1, key: 1, title: 1, projectId: 1, statusCategory: 1, dueDate: 1 } },
          ],
        },
      },
    ];
    const [out] = await Task.aggregate<MyTaskStatsRaw>(pipeline).option(OPTIONS);
    return out!;
  },

  waitingForMyTesting(
    workspaceId: Types.ObjectId,
    userId: Types.ObjectId,
    projectIds: Types.ObjectId[] | null,
  ): Promise<number> {
    return Task.countDocuments({
      workspaceId,
      testerId: userId,
      statusCategory: 'testing',
      ...inProjects(projectIds),
    });
  },

  myOpenTickets(
    workspaceId: Types.ObjectId,
    userId: Types.ObjectId,
    projectIds: Types.ObjectId[] | null,
  ): Promise<number> {
    return Ticket.countDocuments({
      workspaceId,
      assigneeId: userId,
      statusCategory: { $ne: 'done' },
      ...inProjects(projectIds),
    });
  },

  /** Goals I own for today and this week (not cancelled), lowest progress first. */
  myGoals(
    workspaceId: Types.ObjectId,
    userId: Types.ObjectId,
    dayKey: string,
    weekKey: string,
    projectIds: Types.ObjectId[] | null,
  ): Promise<MyGoal[]> {
    const filter: FilterQuery<IGoal> = {
      workspaceId,
      ownerId: userId,
      status: { $ne: 'cancelled' },
      $or: [
        { period: 'daily', periodKey: dayKey },
        { period: 'weekly', periodKey: weekKey },
      ],
    };
    if (projectIds)
      filter.$and = [{ $or: [{ scope: { $ne: 'project' } }, { projectId: { $in: projectIds } }] }];
    return Goal.find(filter, { _id: 1, title: 1, period: 1, progressPct: 1, status: 1 })
      .sort({ progressPct: 1, createdAt: 1, _id: 1 })
      .limit(200)
      .lean<MyGoal[]>();
  },

  /** Tasks and tickets I'm assigned to (or testing) that changed recently: the "my things" for the activity feed. */
  async myRecentEntities(
    workspaceId: Types.ObjectId,
    userId: Types.ObjectId,
    projectIds: Types.ObjectId[] | null,
    since: Date,
    limit: number,
  ): Promise<{ tasks: Types.ObjectId[]; tickets: Types.ObjectId[] }> {
    const [tasks, tickets] = await Promise.all([
      Task.find(
        {
          workspaceId,
          $or: [{ assigneeId: userId }, { testerId: userId }],
          updatedAt: { $gte: since },
          ...inProjects(projectIds),
        },
        { _id: 1 },
      )
        .sort({ updatedAt: -1 })
        .limit(limit)
        .lean<{ _id: Types.ObjectId }[]>(),
      Ticket.find(
        { workspaceId, assigneeId: userId, updatedAt: { $gte: since }, ...inProjects(projectIds) },
        { _id: 1 },
      )
        .sort({ updatedAt: -1 })
        .limit(limit)
        .lean<{ _id: Types.ObjectId }[]>(),
    ]);
    return { tasks: tasks.map((t) => t._id), tickets: tickets.map((t) => t._id) };
  },

  /** Latest entries on the given entities by anyone but me. Served by { workspaceId, entityType, entityId, at }. */
  activityOn(
    workspaceId: Types.ObjectId,
    userId: Types.ObjectId,
    ids: { tasks: Types.ObjectId[]; tickets: Types.ObjectId[] },
    limit: number,
  ): Promise<IActivity[]> {
    const or: FilterQuery<IActivity>[] = [];
    if (ids.tasks.length) or.push({ entityType: 'task', entityId: { $in: ids.tasks } });
    if (ids.tickets.length) or.push({ entityType: 'ticket', entityId: { $in: ids.tickets } });
    if (!or.length) return Promise.resolve([]);
    return Activity.find({ workspaceId, actorId: { $ne: userId }, $or: or })
      .sort({ at: -1, _id: -1 })
      .limit(limit)
      .lean<IActivity[]>();
  },
};
