import { Types, type FilterQuery } from 'mongoose';
import {
  hasRoleAtLeast,
  type CalendarItemDto,
  type CreateGoalInput,
  type GoalDetailDto,
  type GoalDto,
  type GoalListDto,
  type GoalProgressInput,
  type GoalScope,
  type GoalStatus,
  type GoalSummaryDto,
  type GoalSummaryQuery,
  type KeyResultInput,
  type ListGoalsQuery,
  type SearchHitDto,
  type UpdateGoalInput,
} from '@teamtrack/shared';
import { withTransaction } from '../../db/transaction';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors/AppError';
import type { AuthContext } from '../../auth/context';
import type { IGoal, IKeyResult } from '../../models/Goal';
import type { IProject } from '../../models/Project';
import type { IUser } from '../../models/User';
import { memberRepository, projectRepository } from '../../repositories/projectRepository';
import { userRepository } from '../../repositories/userRepository';
import { workspaceRepository } from '../../repositories/workspaceRepository';
import { recordActivity, type ActivityChange } from '../../services/activity';
import type { EntityInfo } from '../../services/entityAccess';
import type { CalendarRange } from '../../services/discovery';
import { realtime } from '../../services/realtime';
import type { DomainEvents } from '../../events/bus';
import { logger } from '../../observability/logger';
import { canSeeProject, projectsService } from '../projects/projects.service';
import { goalRepository, goalTaskRepository, goalWorkspaceRepository, type LinkedTask } from './goals.repository';
import { computeProgress, deriveStatus, normalizeMeasure, shortTitle, toGoalDto } from './goals.dto';
import { canRollUp, keyRange, localDay, nextPeriod, PARENT_PERIOD, periodContaining, type PeriodRange } from './period';

/*
 * Goals. Rules:
 *  - personal: the owner edits; everyone in the workspace can view (guests only their own).
 *  - team: managers and above create/edit; visible like personal goals.
 *  - project: project leads and admins edit; visible to whoever can see the project.
 *  - Versions guard what people edit. System-derived fields (progress from linked tasks, the
 *    status the rollover job sets) change without a version bump, so they never 409 an edit.
 */

const DEFAULT_TZ = 'Asia/Kolkata';
const CHILDREN_LIMIT = 100;
const LINKING_LIMIT = 500;
const ROLLOVER_BATCH = 500;
const SEARCH_RESULTS_MAX = 20;
const CALENDAR_LIMIT = 500;

const oid = (id: string) => new Types.ObjectId(id);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pct = (n: number) => `${n}%`;

export const STATUS_COLOR: Record<GoalStatus, string> = {
  active: '#6366f1',
  achieved: '#16a34a',
  missed: '#dc2626',
  carried_over: '#d97706',
  cancelled: '#a3a3a3',
};

/* ------------------------------------------------------------------ viewer */

/** What the caller can see across projects, loaded once per request. */
interface Viewer {
  ctx: AuthContext;
  isAdmin: boolean;
  /** Visible project ids; null = all (admins). */
  projectIds: Types.ObjectId[] | null;
  leadOf: Set<string>;
}

async function loadViewer(ctx: AuthContext): Promise<Viewer> {
  const isAdmin = hasRoleAtLeast(ctx.role, 'admin');
  const memberships = await memberRepository.listForUser(ctx.workspaceId, ctx.userId);
  const leadOf = new Set(memberships.filter((m) => m.role === 'lead').map((m) => m.projectId.toHexString()));
  if (isAdmin) return { ctx, isAdmin, projectIds: null, leadOf };
  const projectIds = await projectRepository.visibleIds(ctx.workspaceId, {
    memberOf: memberships.map((m) => m.projectId),
    includeWorkspaceVisible: ctx.role !== 'guest',
  });
  return { ctx, isAdmin, projectIds, leadOf };
}

/** Mongo filter for the goals a viewer may see (empty for admins). */
function visibleFilter(v: Viewer): FilterQuery<IGoal> {
  if (v.isAdmin) return {};
  const nonProject: FilterQuery<IGoal> = v.ctx.role === 'guest' ? { scope: { $ne: 'project' }, ownerId: v.ctx.userId } : { scope: { $ne: 'project' } };
  return { $or: [nonProject, { scope: 'project', projectId: { $in: v.projectIds ?? [] } }] };
}

function canView(v: Viewer, g: Pick<IGoal, 'scope' | 'ownerId' | 'projectId'>): boolean {
  if (v.isAdmin) return true;
  if (g.scope === 'project') return !!g.projectId && !!v.projectIds?.some((id) => id.equals(g.projectId!));
  return v.ctx.role !== 'guest' || g.ownerId.equals(v.ctx.userId);
}

function canEditAs(ctx: AuthContext, scope: GoalScope, ownerId: Types.ObjectId, projectLead: boolean): boolean {
  if (scope === 'personal') return ownerId.equals(ctx.userId);
  if (scope === 'team') return hasRoleAtLeast(ctx.role, 'manager');
  return hasRoleAtLeast(ctx.role, 'admin') || projectLead;
}

/** For lists: whether the viewer may edit (archived projects are caught on write). */
const canEditInList = (v: Viewer, g: IGoal) => canEditAs(v.ctx, g.scope, g.ownerId, !!g.projectId && v.leadOf.has(g.projectId.toHexString()));

function visibleTasks(v: Viewer, tasks: LinkedTask[]): LinkedTask[] {
  return v.projectIds === null ? tasks : tasks.filter((t) => v.projectIds!.some((id) => id.equals(t.projectId)));
}

/* ------------------------------------------------------------------ access */

interface GoalAccess {
  goal: IGoal;
  canEdit: boolean;
  project: IProject | null;
}

/** Loads a goal the caller can see (404 for both "missing" and "not visible"). */
async function loadGoal(ctx: AuthContext, id: string | Types.ObjectId): Promise<GoalAccess> {
  const goal = await goalRepository.findById(ctx.workspaceId, id);
  if (!goal) throw new NotFoundError('Goal');
  if (goal.scope !== 'project') {
    if (ctx.role === 'guest' && !goal.ownerId.equals(ctx.userId)) throw new NotFoundError('Goal');
    return { goal, canEdit: canEditAs(ctx, goal.scope, goal.ownerId, false), project: null };
  }
  try {
    const a = await projectsService.access(ctx, goal.projectId!);
    return { goal, canEdit: a.canManage, project: a.project };
  } catch (err) {
    if (err instanceof NotFoundError) throw new NotFoundError('Goal');
    throw err;
  }
}

function assertEditable(a: GoalAccess): void {
  if (!a.canEdit) {
    const who = { personal: 'Only the owner', team: 'Only managers and above', project: 'Only project leads and admins' }[a.goal.scope];
    throw new ForbiddenError(`${who} can change this goal`);
  }
  if (a.project?.status === 'archived') throw new ConflictError('This project is archived. Restore it to make changes.');
}

function assertOpen(g: IGoal): void {
  if (g.status === 'carried_over' || g.status === 'cancelled') throw new ConflictError(`This goal is ${g.status === 'cancelled' ? 'cancelled' : 'carried over'}`);
}

/* ------------------------------------------------------------------ helpers */

async function timezone(ctx: AuthContext): Promise<string> {
  return (await workspaceRepository.findById(ctx.workspaceId))?.timezone ?? DEFAULT_TZ;
}

async function resolvePeriod(ctx: AuthContext, period: IGoal['period'], date: string | undefined): Promise<PeriodRange> {
  const tz = await timezone(ctx);
  return periodContaining(period, date ?? localDay(tz, new Date()), tz);
}

const publicPeriod = (r: PeriodRange) => ({ period: r.period, key: r.key, start: r.start, end: r.end });

async function loadUsers(ctx: AuthContext, ids: Types.ObjectId[]): Promise<Map<string, IUser>> {
  const unique = [...new Map(ids.map((id) => [id.toHexString(), id])).values()];
  if (!unique.length) return new Map();
  const users = await userRepository.findByIds(ctx.workspaceId, unique);
  return new Map(users.map((u) => [u._id.toHexString(), u]));
}

async function toDtos(v: Viewer, goals: IGoal[]): Promise<GoalDto[]> {
  const users = await loadUsers(v.ctx, goals.map((g) => g.ownerId));
  return goals.map((g) => toGoalDto(g, users, canEditInList(v, g)));
}

async function toDto(ctx: AuthContext, goal: IGoal, canEdit: boolean): Promise<GoalDto> {
  return toGoalDto(goal, await loadUsers(ctx, [goal.ownerId]), canEdit);
}

/** Owner of a team/project goal: an active member of the workspace who can see the project. */
async function assertOwner(ctx: AuthContext, ownerId: Types.ObjectId, project: IProject | null): Promise<void> {
  if (ownerId.equals(ctx.userId)) return;
  const fail = (message: string) => new ValidationError([{ path: 'ownerId', message }]);
  const user = await userRepository.findById(ctx.workspaceId, ownerId);
  if (!user || user.status !== 'active') throw fail('The owner must be an active member of this workspace');
  if (!project) {
    if (user.role === 'guest') throw fail('Guests can only own their personal goals');
    return;
  }
  const membership = await memberRepository.find(ctx.workspaceId, project._id, ownerId);
  if (membership ? membership.role === 'viewer' : !canSeeProject(project, user)) throw fail(`${user.name} can't own goals in this project`);
}

/** Tasks to link: all in this workspace and visible to the caller. Returns them for counts and labels. */
async function assertLinkable(v: Viewer, ids: Types.ObjectId[]): Promise<LinkedTask[]> {
  const tasks = await goalTaskRepository.findByIds(v.ctx.workspaceId, ids);
  if (tasks.length !== ids.length || visibleTasks(v, tasks).length !== ids.length) {
    throw new ValidationError([{ path: 'linkedTaskIds', message: 'One or more tasks were not found' }]);
  }
  return tasks;
}

const PARENT_HINT = { daily: 'a weekly goal for the same week', weekly: 'a monthly goal for an overlapping month', monthly: '' } as const;

/** A parent is one period level up, visible, open, and shares days with the child's period. */
async function assertParent(v: Viewer, parentId: Types.ObjectId, child: Pick<IGoal, 'period' | 'periodKey'>): Promise<void> {
  const fail = (message: string) => new ValidationError([{ path: 'parentGoalId', message }]);
  if (!PARENT_PERIOD[child.period]) throw fail('Monthly goals are the top level and have no parent');
  const parent = await goalRepository.findById(v.ctx.workspaceId, parentId);
  if (!parent || !canView(v, parent)) throw fail('Parent goal not found');
  if (!canRollUp(keyRange(child.period, child.periodKey), keyRange(parent.period, parent.periodKey))) {
    throw fail(`A ${child.period} goal can only roll up into ${PARENT_HINT[child.period]}`);
  }
  if (parent.status === 'cancelled' || parent.status === 'carried_over') throw fail('The parent goal is closed');
}

/** Key results from input: existing ids keep their identity; unknown ids are rejected. */
function buildKeyResults(input: KeyResultInput[], existing: IKeyResult[]): IKeyResult[] {
  return input.map((kr, i) => {
    let _id = new Types.ObjectId();
    if (kr.id) {
      const found = existing.find((e) => e._id.equals(kr.id!));
      if (!found) throw new ValidationError([{ path: `keyResults.${i}.id`, message: 'Unknown key result' }]);
      _id = found._id;
    }
    return { _id, title: kr.title, target: kr.target, current: kr.current, unit: kr.unit };
  });
}

/** Progress, status and closedAt for a goal with some fields changed. */
function derived(g: IGoal, next: Partial<IGoal>, now = new Date()) {
  const merged = { ...g, ...next };
  const progressPct = computeProgress(merged);
  return { progressPct, ...deriveStatus(merged, progressPct, now) };
}

/** Tells the owner, and anyone viewing the project, to refresh. Call after commit. */
function broadcast(g: Pick<IGoal, '_id' | 'ownerId' | 'projectId'>, kind: 'created' | 'updated' | 'deleted', actorId: Types.ObjectId): void {
  const e = { goalId: g._id.toHexString(), kind, actorId: actorId.toHexString() };
  realtime.toUser(g.ownerId.toHexString(), 'goal:changed', e);
  if (g.projectId) realtime.toProject(g.projectId.toHexString(), 'goal:changed', e);
}

const activity = (ctx: AuthContext, g: IGoal, action: string, changes?: ActivityChange[]) => ({
  workspaceId: ctx.workspaceId,
  projectId: g.projectId,
  entityType: 'goal' as const,
  entityId: g._id,
  entityKey: shortTitle(g.title),
  actorId: ctx.userId,
  action,
  ...(changes?.length ? { changes } : {}),
});

/* ------------------------------------------------------------------ service */

export const goalsService = {
  async list(ctx: AuthContext, q: ListGoalsQuery): Promise<GoalListDto> {
    const [range, v] = await Promise.all([resolvePeriod(ctx, q.period, q.date), loadViewer(ctx)]);
    const filter: FilterQuery<IGoal> = { workspaceId: ctx.workspaceId, period: q.period, periodKey: range.key };
    const vis = visibleFilter(v);
    if (vis.$or) filter.$and = [vis];
    if (q.owner === 'me') filter.ownerId = ctx.userId;
    else if (q.owner !== 'team') filter.ownerId = oid(q.owner);
    if (q.projectId) filter.projectId = (await projectsService.access(ctx, q.projectId)).project._id;
    if (q.status) filter.status = q.status;

    const page = await goalRepository.list(filter, q.limit, q.cursor);
    return { items: await toDtos(v, page.items), nextCursor: page.nextCursor, period: publicPeriod(range) };
  },

  async summary(ctx: AuthContext, q: GoalSummaryQuery): Promise<GoalSummaryDto> {
    const [range, v] = await Promise.all([resolvePeriod(ctx, q.period, q.date), loadViewer(ctx)]);
    const match: FilterQuery<IGoal> = { workspaceId: ctx.workspaceId, period: q.period, periodKey: range.key, status: { $ne: 'cancelled' } };
    const vis = visibleFilter(v);
    if (vis.$or) match.$and = [vis];
    // Managers and above compare everyone; others see their own row next to the team's.
    const peopleFilter = hasRoleAtLeast(ctx.role, 'manager') ? {} : { ownerId: ctx.userId };
    const { people, team } = await goalRepository.summary(match, peopleFilter);

    const users = await loadUsers(ctx, people.flatMap((p) => (p._id ? [p._id] : [])));
    const row = (b: { goals: number; achieved: number; progress: number } | undefined) => ({
      goals: b?.goals ?? 0,
      achieved: b?.achieved ?? 0,
      avgProgress: b?.goals ? Math.round(b.progress / b.goals) : 0,
    });
    return {
      period: publicPeriod(range),
      people: people
        .flatMap((p) => {
          const u = p._id && users.get(p._id.toHexString());
          return u ? [{ user: { id: u._id.toHexString(), name: u.name }, ...row(p) }] : [];
        })
        .sort((a, b) => a.user.name.localeCompare(b.user.name)),
      team: row(team[0]),
    };
  },

  async get(ctx: AuthContext, id: string): Promise<GoalDetailDto> {
    const a = await loadGoal(ctx, id);
    const v = await loadViewer(ctx);
    const [tasks, children] = await Promise.all([
      goalTaskRepository.findByIds(ctx.workspaceId, a.goal.linkedTaskIds),
      goalRepository.children(ctx.workspaceId, a.goal._id, CHILDREN_LIMIT),
    ]);
    // Keep the goal's own link order.
    const order = new Map(a.goal.linkedTaskIds.map((tid, i) => [tid.toHexString(), i]));
    const linkedTasks = visibleTasks(v, tasks)
      .sort((x, y) => (order.get(x._id.toHexString()) ?? 0) - (order.get(y._id.toHexString()) ?? 0))
      .map((t) => ({ id: t._id.toHexString(), key: t.key, title: t.title, projectId: t.projectId.toHexString(), statusCategory: t.statusCategory }));
    return {
      ...(await toDto(ctx, a.goal, a.canEdit)),
      linkedTasks,
      children: await toDtos(v, children.filter((c) => canView(v, c))),
    };
  },

  async create(ctx: AuthContext, input: CreateGoalInput): Promise<GoalDto> {
    let project: IProject | null = null;
    if (input.scope === 'personal') {
      if (input.ownerId && input.ownerId !== ctx.userId.toHexString()) {
        throw new ValidationError([{ path: 'ownerId', message: 'Personal goals belong to the person who sets them' }]);
      }
    } else if (input.scope === 'team') {
      if (!hasRoleAtLeast(ctx.role, 'manager')) throw new ForbiddenError('Only managers and above can set team goals');
    } else {
      const a = await projectsService.access(ctx, input.projectId!);
      if (!a.canManage) throw new ForbiddenError('Only project leads and admins can set project goals');
      if (a.project.status === 'archived') throw new ConflictError('This project is archived. Restore it to make changes.');
      project = a.project;
    }
    const ownerId = input.ownerId ? oid(input.ownerId) : ctx.userId;
    const linkedTaskIds = [...new Set(input.linkedTaskIds)].map(oid);
    const [range, v] = await Promise.all([resolvePeriod(ctx, input.period, input.date), loadViewer(ctx), assertOwner(ctx, ownerId, project)]);
    const linked = await assertLinkable(v, linkedTaskIds);
    const parentGoalId = input.parentGoalId ? oid(input.parentGoalId) : null;
    if (parentGoalId) await assertParent(v, parentGoalId, { period: input.period, periodKey: range.key });

    const measure = normalizeMeasure(input.measure, input.target, input.current);
    const tasks = { total: linked.length, done: linked.filter((t) => t.statusCategory === 'done').length };
    const doc: Partial<IGoal> = {
      workspaceId: ctx.workspaceId,
      projectId: project?._id ?? null,
      scope: input.scope,
      ownerId,
      period: input.period,
      periodKey: range.key,
      periodStart: range.periodStart,
      periodEnd: range.periodEnd,
      title: input.title,
      description: input.description,
      ...measure,
      unit: input.unit,
      keyResults: buildKeyResults(input.keyResults, []),
      linkedTaskIds,
      tasks,
      status: 'active',
      closedAt: null,
      parentGoalId,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    };
    Object.assign(doc, derived(doc as IGoal, {}));

    const goal = await withTransaction(async (session) => {
      const created = await goalRepository.create(doc, session);
      await recordActivity(session, activity(ctx, created, 'created'));
      return created;
    });
    broadcast(goal, 'created', ctx.userId);
    return toDto(ctx, goal, true);
  },

  async update(ctx: AuthContext, id: string, input: UpdateGoalInput, expectedVersion: number): Promise<GoalDto> {
    const a = await loadGoal(ctx, id);
    assertEditable(a);
    const g = a.goal;
    const v = await loadViewer(ctx);
    const set: Partial<IGoal> = { updatedBy: ctx.userId };
    const changes: ActivityChange[] = [];

    if (input.title !== undefined && input.title !== g.title) {
      set.title = input.title;
      changes.push({ field: 'title', from: g.title, to: input.title });
    }
    if (input.description !== undefined) set.description = input.description;
    if (input.ownerId !== undefined && input.ownerId !== g.ownerId.toHexString()) {
      if (g.scope === 'personal') throw new ValidationError([{ path: 'ownerId', message: 'Personal goals belong to their owner' }]);
      const ownerId = oid(input.ownerId);
      await assertOwner(ctx, ownerId, a.project);
      const users = await loadUsers(ctx, [g.ownerId, ownerId]);
      set.ownerId = ownerId;
      changes.push({ field: 'owner', from: users.get(g.ownerId.toHexString())?.name ?? null, to: users.get(input.ownerId)?.name ?? null });
    }
    if (input.measure !== undefined || input.target !== undefined) {
      Object.assign(set, normalizeMeasure(input.measure ?? g.measure, input.target ?? g.target, g.current));
      if (input.measure && input.measure !== g.measure) changes.push({ field: 'measure', from: g.measure, to: input.measure });
    }
    if (input.unit !== undefined) set.unit = input.unit;
    if (input.keyResults !== undefined) {
      set.keyResults = buildKeyResults(input.keyResults, g.keyResults);
      changes.push({ field: 'key_results', from: String(g.keyResults.length), to: String(set.keyResults.length) });
    }
    if (input.parentGoalId !== undefined) {
      const parentGoalId = input.parentGoalId ? oid(input.parentGoalId) : null;
      if (parentGoalId) await assertParent(v, parentGoalId, g);
      set.parentGoalId = parentGoalId;
    }

    const now = new Date();
    let base: Pick<IGoal, 'status' | 'closedAt'> = { status: g.status, closedAt: g.closedAt };
    if (input.status !== undefined && input.status !== g.status) {
      if (input.status === 'cancelled') {
        if (g.status === 'carried_over') throw new ConflictError('A carried-over goal is already closed');
        base = { status: 'cancelled', closedAt: now };
      } else {
        if (g.status !== 'cancelled') throw new ConflictError('Only a cancelled goal can be reopened');
        base = { status: 'active', closedAt: null };
      }
      changes.push({ field: 'status', from: g.status, to: input.status });
    }
    Object.assign(set, derived(g, { ...set, ...base }, now));

    const updated = await withTransaction(async (session) => {
      const doc = await goalRepository.update(ctx.workspaceId, g._id, expectedVersion, { $set: set }, session);
      await recordActivity(session, activity(ctx, doc, 'updated', changes));
      return doc;
    });
    broadcast(updated, 'updated', ctx.userId);
    return toDto(ctx, updated, a.canEdit);
  },

  async progress(ctx: AuthContext, id: string, input: GoalProgressInput, expectedVersion: number): Promise<GoalDto> {
    const a = await loadGoal(ctx, id);
    assertEditable(a);
    const g = a.goal;
    assertOpen(g);
    const set: Partial<IGoal> = { updatedBy: ctx.userId };

    if (input.current !== undefined) {
      if (g.measure === 'tasks') throw new ValidationError([{ path: 'current', message: 'This goal tracks its linked tasks' }]);
      set.current = normalizeMeasure(g.measure, g.target, input.current).current;
    }
    if (input.keyResults?.length) {
      const next = g.keyResults.map((kr) => ({ ...kr }));
      input.keyResults.forEach((u, i) => {
        const kr = next.find((k) => k._id.equals(u.id));
        if (!kr) throw new ValidationError([{ path: `keyResults.${i}.id`, message: 'Unknown key result' }]);
        kr.current = u.current;
      });
      set.keyResults = next;
    }
    Object.assign(set, derived(g, set));

    const updated = await withTransaction(async (session) => {
      const doc = await goalRepository.update(ctx.workspaceId, g._id, expectedVersion, { $set: set }, session);
      await recordActivity(session, activity(ctx, doc, 'progress', [{ field: 'progress', from: pct(g.progressPct), to: pct(doc.progressPct) }]));
      return doc;
    });
    broadcast(updated, 'updated', ctx.userId);
    return toDto(ctx, updated, a.canEdit);
  },

  async linkTask(ctx: AuthContext, id: string, taskId: string): Promise<GoalDto> {
    const a = await loadGoal(ctx, id);
    assertEditable(a);
    const tid = oid(taskId);
    if (a.goal.linkedTaskIds.some((x) => x.equals(tid))) return toDto(ctx, a.goal, a.canEdit);
    const [task] = await assertLinkable(await loadViewer(ctx), [tid]);

    const updated = await withTransaction(async (session) => {
      const doc = await goalRepository.pushTask(ctx.workspaceId, a.goal._id, tid, ctx.userId, session);
      if (!doc) {
        const now = await goalRepository.findById(ctx.workspaceId, a.goal._id, session);
        if (!now) throw new NotFoundError('Goal');
        if (now.linkedTaskIds.some((x) => x.equals(tid))) return now; // linked concurrently: same outcome
        throw new ConflictError('This goal already links the maximum of 100 tasks');
      }
      const tasks = await goalTaskRepository.counts(ctx.workspaceId, doc.linkedTaskIds, session);
      const next = { tasks, ...derived(doc, { tasks }) };
      await goalRepository.setDerived(ctx.workspaceId, doc._id, doc.status, next, session);
      await recordActivity(session, activity(ctx, doc, 'linked', [{ field: 'task', from: null, to: task!.key }]));
      return { ...doc, ...next };
    });
    broadcast(updated, 'updated', ctx.userId);
    return toDto(ctx, updated, a.canEdit);
  },

  async unlinkTask(ctx: AuthContext, id: string, taskId: string): Promise<GoalDto> {
    const a = await loadGoal(ctx, id);
    assertEditable(a);
    const tid = oid(taskId);
    const [task] = await goalTaskRepository.findByIds(ctx.workspaceId, [tid]);

    const updated = await withTransaction(async (session) => {
      const doc = await goalRepository.pullTask(ctx.workspaceId, a.goal._id, tid, ctx.userId, session);
      if (!doc) throw new NotFoundError('Linked task');
      const tasks = await goalTaskRepository.counts(ctx.workspaceId, doc.linkedTaskIds, session);
      const next = { tasks, ...derived(doc, { tasks }) };
      await goalRepository.setDerived(ctx.workspaceId, doc._id, doc.status, next, session);
      await recordActivity(session, activity(ctx, doc, 'unlinked', [{ field: 'task', from: task?.key ?? null, to: null }]));
      return { ...doc, ...next };
    });
    broadcast(updated, 'updated', ctx.userId);
    return toDto(ctx, updated, a.canEdit);
  },

  /**
   * Copies an unfinished goal into the next period with what is left to do, and closes the original
   * as carried over. Both are linked, in one transaction.
   */
  async carryOver(ctx: AuthContext, id: string): Promise<GoalDto> {
    const a = await loadGoal(ctx, id);
    assertEditable(a);
    const g = a.goal;
    if (g.carriedToId) throw new ConflictError('This goal was already carried over');
    if (g.status !== 'active' && g.status !== 'missed') throw new ConflictError('Only an active or missed goal can be carried over');

    const next = nextPeriod(g.period, g.periodKey, await timezone(ctx));
    const linked = await goalTaskRepository.findByIds(ctx.workspaceId, g.linkedTaskIds);
    const openTasks = linked.filter((t) => t.statusCategory !== 'done');
    // What's left: remaining amount for numbers, unfinished key results and tasks; percent and yes/no carry as they are.
    const left = g.target - g.current;
    const remaining = g.measure === 'number' ? { target: left > 0 ? left : g.target, current: 0 } : { target: g.target, current: g.current };
    const keyResults = g.keyResults
      .filter((kr) => kr.current < kr.target)
      .map((kr) => ({ _id: new Types.ObjectId(), title: kr.title, target: kr.target - kr.current, current: 0, unit: kr.unit }));
    const doc: Partial<IGoal> = {
      workspaceId: ctx.workspaceId,
      projectId: g.projectId,
      scope: g.scope,
      ownerId: g.ownerId,
      period: g.period,
      periodKey: next.key,
      periodStart: next.periodStart,
      periodEnd: next.periodEnd,
      title: g.title,
      description: g.description,
      measure: g.measure,
      ...remaining,
      unit: g.unit,
      keyResults,
      linkedTaskIds: openTasks.map((t) => t._id),
      tasks: { total: openTasks.length, done: 0 },
      status: 'active',
      closedAt: null,
      carriedFromId: g._id,
      parentGoalId: null,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    };
    Object.assign(doc, derived(doc as IGoal, {}));

    const { created, original } = await withTransaction(async (session) => {
      const copy = await goalRepository.create(doc, session);
      const closed = await goalRepository.markCarried(ctx.workspaceId, g._id, copy._id, ctx.userId, session);
      if (!closed) throw new ConflictError('This goal changed while carrying it over. Reload and try again.');
      await recordActivity(
        session,
        activity(ctx, closed, 'carried_over', [{ field: 'period', from: g.periodKey, to: next.key }]),
        activity(ctx, copy, 'created', [{ field: 'carried_from', from: null, to: g.periodKey }]),
      );
      return { created: copy, original: closed };
    });
    broadcast(original, 'updated', ctx.userId);
    broadcast(created, 'created', ctx.userId);
    return toDto(ctx, created, a.canEdit);
  },

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const a = await loadGoal(ctx, id);
    // Admins may also remove someone else's goal (moderation).
    if (!a.canEdit && !hasRoleAtLeast(ctx.role, 'admin')) assertEditable(a);
    if (a.project?.status === 'archived') throw new ConflictError('This project is archived. Restore it to make changes.');
    await withTransaction(async (session) => {
      if (!(await goalRepository.softDelete(ctx.workspaceId, a.goal._id, ctx.userId, session))) throw new NotFoundError('Goal');
      await goalRepository.detachChildren(ctx.workspaceId, a.goal._id, session);
      await recordActivity(session, activity(ctx, a.goal, 'deleted'));
    });
    broadcast(a.goal, 'deleted', ctx.userId);
  },

  /* ------------------------------------------------------- cross-module hooks */

  /** Entity info for comments, attachments, activity and notifications. */
  async resolveEntity(ctx: AuthContext, id: Types.ObjectId): Promise<EntityInfo | null> {
    let a: GoalAccess;
    try {
      a = await loadGoal(ctx, id);
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
    const g = a.goal;
    const writable = a.canEdit && a.project?.status !== 'archived';
    const projectName = a.project?.name ?? (await workspaceRepository.findById(ctx.workspaceId))?.name ?? 'Workspace';
    return {
      type: 'goal',
      id: g._id,
      projectId: g.projectId,
      projectName,
      key: shortTitle(g.title),
      title: g.title,
      path: `/goals?goal=${g._id.toHexString()}`,
      // Anyone who can see a goal (except guests) may comment on it; editors moderate.
      canWrite: writable || (ctx.role !== 'guest' && a.project?.status !== 'archived'),
      canManage: writable,
      participants: [g.ownerId, g.createdBy].filter((x): x is Types.ObjectId => !!x),
    };
  },

  async search(ctx: AuthContext, q: string, limit: number): Promise<SearchHitDto[]> {
    const v = await loadViewer(ctx);
    const filter: FilterQuery<IGoal> = { workspaceId: ctx.workspaceId, title: new RegExp(escapeRegex(q), 'i') };
    const vis = visibleFilter(v);
    if (vis.$or) filter.$and = [vis];
    const goals = await goalRepository.find(filter, { periodEnd: -1, _id: -1 }, Math.min(limit, SEARCH_RESULTS_MAX));
    return goals.map((g) => ({
      type: 'goal' as const,
      id: g._id.toHexString(),
      title: g.title,
      subtitle: `${g.period[0]!.toUpperCase()}${g.period.slice(1)} goal · ${g.periodKey} · ${g.status.replace('_', ' ')}`,
      path: `/goals?goal=${g._id.toHexString()}`,
    }));
  },

  /** One item per goal, on the last day of its period. */
  async calendar(ctx: AuthContext, range: CalendarRange): Promise<CalendarItemDto[]> {
    const v = await loadViewer(ctx);
    const from = range.from.toISOString().slice(0, 10);
    const to = range.to.toISOString().slice(0, 10);
    // periodEnd is local midnight after the last day; a +-1 day margin covers every timezone offset.
    const filter: FilterQuery<IGoal> = {
      workspaceId: ctx.workspaceId,
      periodEnd: { $gt: range.from, $lte: new Date(range.to.getTime() + 2 * 86_400_000) },
      status: { $ne: 'cancelled' },
    };
    const vis = visibleFilter(v);
    if (vis.$or) filter.$and = [vis];
    if (range.projectId) filter.projectId = range.projectId;
    if (range.userId) filter.ownerId = range.userId;
    const goals = await goalRepository.find(filter, { periodEnd: 1, _id: 1 }, CALENDAR_LIMIT);
    return goals.flatMap((g) => {
      const date = keyRange(g.period, g.periodKey).end;
      if (date < from || date > to) return [];
      return [
        {
          type: 'goal' as const,
          id: g._id.toHexString(),
          key: shortTitle(g.title),
          title: g.title,
          date,
          path: `/goals?goal=${g._id.toHexString()}`,
          color: STATUS_COLOR[g.status],
          done: g.status === 'achieved',
        },
      ];
    });
  },

  /**
   * A linked task changed: refresh task counts, progress and (while the period runs) achieved/active
   * on open goals linking it. Idempotent: recomputes from the tasks collection each time.
   */
  async onTaskChanged(e: DomainEvents['task.changed']): Promise<void> {
    if (e.kind === 'created') return;
    const goals = await goalRepository.openLinking(e.workspaceId, e.taskId, LINKING_LIMIT);
    if (e.kind === 'deleted') await goalRepository.pullTaskEverywhere(e.workspaceId, e.taskId);
    for (const g of goals) {
      const ids = e.kind === 'deleted' ? g.linkedTaskIds.filter((x) => !x.equals(e.taskId)) : g.linkedTaskIds;
      const tasks = await goalTaskRepository.counts(e.workspaceId, ids);
      const next = { tasks, ...derived(g, { tasks }) };
      const same = next.tasks.total === g.tasks.total && next.tasks.done === g.tasks.done && next.progressPct === g.progressPct && next.status === g.status;
      if (same && e.kind !== 'deleted') continue;
      if (await goalRepository.setDerived(e.workspaceId, g._id, g.status, next)) broadcast(g, 'updated', e.actorId);
    }
  },

  /**
   * Closes goals whose period has ended: achieved at 100%, otherwise missed. Batched per workspace,
   * every query tenant-scoped; safe to rerun (updates re-check status).
   */
  async rollover(now = new Date()): Promise<{ achieved: number; missed: number }> {
    const total = { achieved: 0, missed: 0 };
    for (const workspaceId of await goalWorkspaceRepository.ids()) {
      for (;;) {
        const batch = await goalRepository.endedActive(workspaceId, now, ROLLOVER_BATCH);
        if (!batch.length) break;
        const done = batch.filter((g) => g.progressPct >= 100);
        const missed = batch.filter((g) => g.progressPct < 100);
        const achieved = await goalRepository.close(workspaceId, done.map((g) => g._id), 'achieved', now);
        const closedMissed = await goalRepository.close(workspaceId, missed.map((g) => g._id), 'missed', now);
        total.achieved += achieved;
        total.missed += closedMissed;
        for (const g of batch) broadcast(g, 'updated', g.ownerId);
        // A short batch is the last; a batch that changed nothing (raced with edits) is left for the next run.
        if (batch.length < ROLLOVER_BATCH || achieved + closedMissed === 0) break;
      }
    }
    if (total.achieved || total.missed) logger.info(total, 'goal periods rolled over');
    return total;
  },
};
