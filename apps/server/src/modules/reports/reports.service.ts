import type { FilterQuery, Types } from 'mongoose';
import {
  GOAL_PERIODS,
  hasRoleAtLeast,
  REPORT_DEFAULT_WEEKS,
  REPORT_MAX_DAYS,
  STATUS_CATEGORIES,
  TICKET_SEVERITIES,
  TICKET_TYPES,
  type DashboardGoalsDto,
  type GoalPeriod,
  type MyDashboardDto,
  type PersonRef,
  type ReportAssigneeDto,
  type ReportGoalPeriodDto,
  type ReportWeekDto,
  type StatusCategory,
  type TeamReportDto,
  type TeamReportQuery,
} from '@teamtrack/shared';
import type { AuthContext } from '../../auth/context';
import { NotFoundError, ValidationError } from '../../errors/AppError';
import type { IGoal } from '../../models/Goal';
import { userRepository } from '../../repositories/userRepository';
import { workspaceRepository } from '../../repositories/workspaceRepository';
import { loadPeople, toActivityDto } from '../collab/collab.dto';
import { addDays, isoWeek, localDay, zonedMidnight } from '../goals/period';
import { visibilityOf, type Visibility } from '../planning/visibility';
import { projectsService } from '../projects/projects.service';
import {
  reportsRepository,
  type Bucket,
  type GoalTotalsRaw,
  type MyGoal,
  type ReportScope,
  type ReportWindow,
} from './reports.repository';

const DAY_MS = 86_400_000;
const GOAL_ITEMS = 5;
const ACTIVITY_LIMIT = 10;
/** "My things" for the activity feed: what I'm on that changed in this many days. */
const ACTIVITY_WINDOW_DAYS = 14;
const ACTIVITY_ENTITY_LIMIT = 100;

const pad = (n: number) => String(n).padStart(2, '0');
const weekKey = (day: string) => {
  const w = isoWeek(day);
  return `${w.year}-W${pad(w.week)}`;
};
/** A YYYY-MM-DD day as the Date due dates are stored as (00:00 UTC). */
const dayDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
const daySpan = (from: string, to: string) =>
  (dayDate(to).getTime() - dayDate(from).getTime()) / DAY_MS + 1;
const first = (rows: { n: number }[]) => rows[0]?.n ?? 0;
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : null);
const byId = (rows: Bucket[]) => new Map(rows.map((r) => [r._id, r.n]));

async function timezoneOf(ctx: AuthContext): Promise<string> {
  const ws = await workspaceRepository.findById(ctx.workspaceId);
  if (!ws) throw new NotFoundError('Workspace');
  return ws.timezone;
}

/** Resolves defaults and re-checks the bounds the schema can only check when both ends are given. */
function resolveRange(q: TeamReportQuery, today: string): { from: string; to: string } {
  const to = q.to ?? today;
  const from = q.from ?? isoWeek(addDays(to, -7 * (REPORT_DEFAULT_WEEKS - 1))).monday;
  if (to < from)
    throw new ValidationError([
      { path: 'to', message: 'The end date must not be before the start date' },
    ]);
  if (daySpan(from, to) > REPORT_MAX_DAYS)
    throw new ValidationError([
      { path: 'from', message: `At most ${REPORT_MAX_DAYS} days at a time` },
    ]);
  return { from, to };
}

/** The ISO weeks (Monday start) touching [from, to]. */
function weeksOf(from: string, to: string): { week: string; start: string }[] {
  const out: { week: string; start: string }[] = [];
  for (let monday = isoWeek(from).monday; monday <= to; monday = addDays(monday, 7))
    out.push({ week: weekKey(monday), start: monday });
  return out;
}

/** Same rule as goal lists: admins see all; others see non-project goals (guests only their own) and goals of visible projects. */
function goalVisibility(ctx: AuthContext, vis: Visibility): FilterQuery<IGoal> {
  if (vis.projectIds === null) return {};
  const nonProject: FilterQuery<IGoal> =
    ctx.role === 'guest'
      ? { scope: { $ne: 'project' }, ownerId: ctx.userId }
      : { scope: { $ne: 'project' } };
  return { $or: [nonProject, { scope: 'project', projectId: { $in: vis.projectIds } }] };
}

function goalRow(r: GoalTotalsRaw | undefined): ReportGoalPeriodDto {
  const total = r?.total ?? 0;
  const achieved = r?.achieved ?? 0;
  return {
    total,
    achieved,
    completionPct: pct(achieved, total),
    avgProgress: total ? Math.round(r!.progress / total) : null,
  };
}

function goalsFor(key: string, goals: MyGoal[]): DashboardGoalsDto {
  const achieved = goals.filter(
    (g) => g.status === 'achieved' || (g.status === 'active' && g.progressPct >= 100),
  ).length;
  const progress = goals.reduce((sum, g) => sum + g.progressPct, 0);
  return {
    key,
    total: goals.length,
    achieved,
    avgProgress: goals.length ? Math.round(progress / goals.length) : 0,
    items: goals
      .slice(0, GOAL_ITEMS)
      .map((g) => ({
        id: g._id.toHexString(),
        title: g.title,
        progressPct: g.progressPct,
        status: g.status,
      })),
  };
}

async function peopleRefs(
  ctx: AuthContext,
  ids: Types.ObjectId[],
): Promise<Map<string, PersonRef>> {
  if (!ids.length) return new Map();
  const users = await userRepository.findByIds(ctx.workspaceId, ids);
  return new Map(
    users.map((u) => [u._id.toHexString(), { id: u._id.toHexString(), name: u.name }]),
  );
}

export const reportsService = {
  /** The caller's own numbers for the dashboard. Only work in projects they can still see is counted. */
  async myDashboard(ctx: AuthContext): Promise<MyDashboardDto> {
    const [timezone, vis] = await Promise.all([timezoneOf(ctx), visibilityOf(ctx)]);
    const today = localDay(timezone, new Date());
    const weekEnd = addDays(isoWeek(today).monday, 6);
    const { workspaceId, userId } = ctx;
    const since = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * DAY_MS);

    const [stats, waiting, openTickets, goals, entities] = await Promise.all([
      reportsRepository.myTaskStats(
        workspaceId,
        userId,
        vis.projectIds,
        dayDate(today),
        dayDate(weekEnd),
      ),
      reportsRepository.waitingForMyTesting(workspaceId, userId, vis.projectIds),
      reportsRepository.myOpenTickets(workspaceId, userId, vis.projectIds),
      reportsRepository.myGoals(workspaceId, userId, today, weekKey(today), vis.projectIds),
      reportsRepository.myRecentEntities(
        workspaceId,
        userId,
        vis.projectIds,
        since,
        ACTIVITY_ENTITY_LIMIT,
      ),
    ]);
    const activity = await reportsRepository.activityOn(
      workspaceId,
      userId,
      entities,
      ACTIVITY_LIMIT,
    );
    const people = await loadPeople(
      workspaceId,
      activity.map((a) => a.actorId),
    );

    const cat = new Map(stats.byStatus.map((b) => [b._id, b.n]));
    const todayDate = dayDate(today);
    return {
      today,
      weekEnd,
      tasks: {
        open: stats.byStatus.reduce((sum, b) => sum + b.n, 0),
        todo: cat.get('todo') ?? 0,
        inProgress: cat.get('in_progress') ?? 0,
        testing: cat.get('testing') ?? 0,
        dueToday: first(stats.dueToday),
        dueThisWeek: first(stats.dueThisWeek),
        overdue: first(stats.overdue),
        waitingForMyTesting: waiting,
      },
      openTickets,
      dueSoon: stats.dueSoon.map((t) => ({
        id: t._id.toHexString(),
        key: t.key,
        title: t.title,
        projectId: t.projectId.toHexString(),
        statusCategory: t.statusCategory,
        dueDate: t.dueDate!.toISOString().slice(0, 10),
        overdue: t.dueDate! < todayDate,
      })),
      goals: {
        today: goalsFor(
          today,
          goals.filter((g) => g.period === 'daily'),
        ),
        week: goalsFor(
          weekKey(today),
          goals.filter((g) => g.period === 'weekly'),
        ),
      },
      activity: activity.map((a) => toActivityDto(a, people)),
    };
  },

  /**
   * Team numbers for a range. Managers and above get the whole team across the projects they can
   * see; everyone else gets the same report limited to their own work ("self" scope). A project
   * filter must be a project the caller can see (404 otherwise, like every project route).
   */
  async team(ctx: AuthContext, q: TeamReportQuery): Promise<TeamReportDto> {
    const [timezone, vis] = await Promise.all([timezoneOf(ctx), visibilityOf(ctx)]);
    const today = localDay(timezone, new Date());
    const { from, to } = resolveRange(q, today);
    const projectId = q.projectId
      ? (await projectsService.access(ctx, q.projectId)).project._id
      : null;

    const isTeam = hasRoleAtLeast(ctx.role, 'manager');
    const scope: ReportScope = {
      workspaceId: ctx.workspaceId,
      projectIds: projectId ? [projectId] : vis.projectIds,
      person: isTeam ? null : ctx.userId,
    };
    const window: ReportWindow = {
      start: zonedMidnight(timezone, from),
      end: zonedMidnight(timezone, addDays(to, 1)),
      today: dayDate(today),
      timezone,
    };

    const [tasks, tickets, goals] = await Promise.all([
      reportsRepository.taskReport(scope, window),
      reportsRepository.ticketReport(scope, window),
      reportsRepository.goalReport(scope, window, goalVisibility(ctx, vis), projectId),
    ]);

    // Weekly series.
    const done = byId(tasks.completedWeeks);
    const opened = byId(tickets.openedWeeks);
    const closed = byId(tickets.closedWeeks);
    const weeklyGoals = new Map(goals.weeks.map((g) => [String(g._id), g]));
    const weeks: ReportWeekDto[] = weeksOf(from, to).map((w) => ({
      ...w,
      tasksDone: done.get(w.week) ?? 0,
      ticketsOpened: opened.get(w.week) ?? 0,
      ticketsClosed: closed.get(w.week) ?? 0,
      goals: weeklyGoals.get(w.week)?.total ?? 0,
      goalsAchieved: weeklyGoals.get(w.week)?.achieved ?? 0,
    }));

    // Per-person load: open work, plus what each finished in the range.
    const rows = new Map<string, Omit<ReportAssigneeDto, 'user'> & { id: Types.ObjectId | null }>();
    const rowFor = (id: Types.ObjectId | null) => {
      const k = id?.toHexString() ?? '';
      let r = rows.get(k);
      if (!r)
        rows.set(k, (r = { id, open: 0, inProgress: 0, testing: 0, overdue: 0, completed: 0 }));
      return r;
    };
    for (const l of tasks.load)
      Object.assign(rowFor(l._id), {
        open: l.open,
        inProgress: l.inProgress,
        testing: l.testing,
        overdue: l.overdue,
      });
    for (const c of tasks.completedBy) rowFor(c._id).completed = c.n;
    const people = await peopleRefs(
      ctx,
      [...rows.values()].flatMap((r) => (r.id ? [r.id] : [])),
    );
    const assignees: ReportAssigneeDto[] = [...rows.values()]
      .map(({ id, ...counts }) => ({
        user: id
          ? (people.get(id.toHexString()) ?? { id: id.toHexString(), name: 'Removed user' })
          : null,
        ...counts,
      }))
      .sort(
        (a, b) =>
          b.open - a.open ||
          b.completed - a.completed ||
          (a.user?.name ?? '').localeCompare(b.user?.name ?? ''),
      );

    const byStatus = Object.fromEntries(STATUS_CATEGORIES.map((c) => [c, 0])) as Record<
      StatusCategory,
      number
    >;
    for (const b of tasks.byStatus) byStatus[b._id] = b.n;
    const completed = tasks.completed[0];
    const testing = tasks.testing[0];
    const goalPeriods = new Map(goals.byPeriod.map((g) => [String(g._id), g]));
    const goalTotals = goals.byPeriod.reduce(
      (acc, g) => ({
        _id: null,
        total: acc.total + g.total,
        achieved: acc.achieved + g.achieved,
        progress: acc.progress + g.progress,
      }),
      { _id: null, total: 0, achieved: 0, progress: 0 } as GoalTotalsRaw,
    );
    const severity = new Map(tickets.bySeverity.map((s) => [s._id, s]));
    const type = new Map(tickets.byType.map((s) => [s._id, s]));

    return {
      range: { from, to, timezone },
      scope: isTeam ? 'team' : 'self',
      projectId: projectId?.toHexString() ?? null,
      tasks: {
        byStatus,
        open: byStatus.todo + byStatus.in_progress + byStatus.testing,
        overdue: tasks.load.reduce((sum, l) => sum + l.overdue, 0),
        created: first(tasks.created),
        completed: completed?.n ?? 0,
        avgLeadTimeDays: completed?.n
          ? Math.round((completed.leadMs / completed.n / DAY_MS) * 10) / 10
          : null,
      },
      assignees,
      weeks,
      tickets: {
        opened: weeks.reduce((sum, w) => sum + w.ticketsOpened, 0),
        closed: weeks.reduce((sum, w) => sum + w.ticketsClosed, 0),
        openNow: first(tickets.openNow),
        bySeverity: TICKET_SEVERITIES.map((key) => ({
          key,
          opened: severity.get(key)?.opened ?? 0,
          open: severity.get(key)?.open ?? 0,
        })),
        byType: TICKET_TYPES.map((key) => ({
          key,
          opened: type.get(key)?.opened ?? 0,
          open: type.get(key)?.open ?? 0,
        })),
      },
      goals: {
        ...goalRow(goalTotals),
        byPeriod: Object.fromEntries(
          GOAL_PERIODS.map((p) => [p, goalRow(goalPeriods.get(p))]),
        ) as Record<GoalPeriod, ReportGoalPeriodDto>,
      },
      testing: {
        passed: testing?.passed ?? 0,
        passedFirstRound: testing?.firstRound ?? 0,
        firstPassRate: pct(testing?.firstRound ?? 0, testing?.passed ?? 0),
      },
    };
  },
};
