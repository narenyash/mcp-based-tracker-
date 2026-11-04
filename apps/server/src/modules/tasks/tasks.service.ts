import { Types, type ClientSession, type FilterQuery } from 'mongoose';
import {
  hasRoleAtLeast,
  PRIORITY_RANK,
  taskKeySchema,
  type BoardDto,
  type CreateLabelInput,
  type CreateTaskInput,
  type LabelDto,
  type ListTasksQuery,
  type MoveTaskInput,
  type Page,
  type TaskDto,
  type UpdateTaskInput,
} from '@teamtrack/shared';
import { withTransaction } from '../../db/transaction';
import { evenRanks, rankBetween, RankOrderError, REBALANCE_LENGTH } from '../../db/rank';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors/AppError';
import type { AuthContext } from '../../auth/context';
import type { IProject, IWorkflowStatus } from '../../models/Project';
import type { ITask } from '../../models/Task';
import type { IUser } from '../../models/User';
import { counterRepository, labelRepository, taskRepository, type RankedTask } from '../../repositories/taskRepository';
import { memberRepository, projectRepository } from '../../repositories/projectRepository';
import { userRepository } from '../../repositories/userRepository';
import { enqueue, type OutboxMessage } from '../../services/outbox';
import { notifyMessage, type NotifyJob } from '../../services/notifier';
import { realtime } from '../../services/realtime';
import { recordActivity, type ActivityChange, type ActivityEntry } from '../../services/activity';
import { logger } from '../../observability/logger';
import { bus } from '../../events/bus';
import { toLabelDto, toTaskDto } from '../dto';
import { canSeeProject, projectsService } from '../projects/projects.service';

type Access = Awaited<ReturnType<typeof projectsService.access>>;
type Users = Map<string, IUser>;

const BOARD_LIMIT = 1000;
const oid = (id: string) => new Types.ObjectId(id);
const sameId = (a: Types.ObjectId | null | undefined, b: Types.ObjectId | null | undefined) => (a && b ? a.equals(b) : !a && !b);
const toDate = (d: string | null) => (d ? new Date(`${d}T00:00:00.000Z`) : null);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const boardChanged = () => new ConflictError('The board changed while you were moving this card. Refresh and try again.');
const isDuplicateKey = (err: unknown) => typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

/* ------------------------------------------------------------------ guards */

function assertWritable(a: Access): void {
  if (!a.canEdit) throw new ForbiddenError('You can view this project but not change its tasks');
  if (a.project.status === 'archived') throw new ConflictError('This project is archived. Restore it to make changes.');
}

async function loadTask(ctx: AuthContext, id: string | Types.ObjectId): Promise<ITask> {
  const task = await taskRepository.findById(ctx.workspaceId, id);
  if (!task) throw new NotFoundError('Task');
  return task;
}

/** Loads a task and checks the caller can see its project (404 for both "missing" and "not visible"). */
async function loadWithAccess(ctx: AuthContext, id: string): Promise<{ task: ITask; a: Access }> {
  const task = await loadTask(ctx, id);
  try {
    return { task, a: await projectsService.access(ctx, task.projectId) };
  } catch (err) {
    if (err instanceof NotFoundError) throw new NotFoundError('Task');
    throw err;
  }
}

function findStatus(a: Access, statusId: string): IWorkflowStatus {
  const status = a.project.workflow.taskStatuses.find((s) => s.id === statusId);
  if (!status) throw new ValidationError([{ path: 'statusId', message: 'Not a status of this project' }]);
  return status;
}

function initialStatus(a: Access): IWorkflowStatus {
  return [...a.project.workflow.taskStatuses].sort((x, y) => x.order - y.order)[0]!;
}

/**
 * Who can be given work (assignee or tester). Existing leads/members always; viewers never.
 * Someone not yet in the project can be assigned if they can already see it, and only by a lead/admin
 * or by themselves ("assign to me"); they are added as a member in the same transaction.
 * Returns the user id to add to the project, or null if they are already a member.
 */
async function checkEligible(ctx: AuthContext, a: Access, userId: Types.ObjectId, field: 'assigneeId' | 'testerId'): Promise<Types.ObjectId | null> {
  const who = field === 'testerId' ? 'tester' : 'assignee';
  const fail = (message: string) => new ValidationError([{ path: field, message }]);
  const [membership, user] = await Promise.all([
    memberRepository.find(ctx.workspaceId, a.project._id, userId),
    userRepository.findById(ctx.workspaceId, userId),
  ]);
  if (!user || user.status !== 'active') throw fail(`The ${who} must be an active member of this workspace`);
  if (membership) {
    if (membership.role === 'viewer') throw fail(`${user.name} is a viewer on this project and can't be the ${who}`);
    return null;
  }
  if (!a.canManage && !userId.equals(ctx.userId)) throw fail(`${user.name} isn't in this project yet. Ask a project lead to add them.`);
  if (!canSeeProject(a.project, user)) throw fail(`${user.name} can't see this project`);
  return userId;
}

/** Adds people pulled in by an assignment. The read inside the transaction makes concurrent joins safe. */
async function joinProject(ctx: AuthContext, a: Access, ids: (Types.ObjectId | null)[], session: ClientSession): Promise<void> {
  const unique = new Map(ids.filter((x): x is Types.ObjectId => !!x).map((id) => [id.toHexString(), id]));
  for (const userId of unique.values()) {
    if (await memberRepository.find(ctx.workspaceId, a.project._id, userId, session)) continue;
    await memberRepository.add({ workspaceId: ctx.workspaceId, projectId: a.project._id, userId, role: 'member', createdBy: ctx.userId }, session);
    await projectRepository.incrementMemberCount(ctx.workspaceId, a.project._id, 1, session);
  }
}

/** Testing is an independent check: the person who did the work cannot sign it off. */
function assertTesterNotAssignee(assigneeId: Types.ObjectId | null, testerId: Types.ObjectId | null): void {
  if (assigneeId && testerId && assigneeId.equals(testerId)) {
    throw new ValidationError([{ path: 'testerId', message: 'Someone other than the assignee must test this task' }]);
  }
}

async function assertLabels(ctx: AuthContext, projectId: Types.ObjectId, ids: Types.ObjectId[]): Promise<void> {
  if (ids.length && (await labelRepository.countInProject(ctx.workspaceId, projectId, ids)) !== ids.length) {
    throw new ValidationError([{ path: 'labelIds', message: 'One or more labels do not belong to this project' }]);
  }
}

const uniqueIds = (ids: string[]) => [...new Set(ids)].map(oid);

/* ------------------------------------------------------------- transitions */

interface Transition {
  set: Record<string, unknown>;
  enteredTesting: boolean;
  failedTesting: boolean;
  passedTesting: boolean;
  /** Change in "is done" (for the parent's subtasksDone counter). */
  doneDelta: -1 | 0 | 1;
}

/**
 * The single place status changes are interpreted. Entering a testing status opens a new test round
 * for `testerId`; leaving it records the outcome (Done = passed, anywhere else = failed).
 */
function transition(
  prev: Pick<ITask, 'statusCategory' | 'testing'> | null,
  to: IWorkflowStatus,
  actorId: Types.ObjectId,
  testerId: Types.ObjectId | null,
  note: string | undefined,
): Transition {
  const now = new Date();
  const from = prev?.statusCategory ?? null;
  const set: Record<string, unknown> = { statusId: to.id, statusCategory: to.category };

  if (to.category !== 'done') set.completedAt = null;
  else if (from !== 'done') set.completedAt = now;

  const enteredTesting = to.category === 'testing' && from !== 'testing';
  const leftTesting = from === 'testing' && to.category !== 'testing' && !!prev?.testing;

  if (enteredTesting) {
    set.testerId = testerId;
    set.testing = { round: (prev?.testing?.round ?? 0) + 1, result: 'pending', sentAt: now, sentBy: actorId, resultAt: null, resultBy: null, note: note ?? '' };
  }
  if (leftTesting) {
    set['testing.result'] = to.category === 'done' ? 'passed' : 'failed';
    set['testing.resultAt'] = now;
    set['testing.resultBy'] = actorId;
    if (note) set['testing.note'] = note;
  }

  const doneDelta = ((to.category === 'done' ? 1 : 0) - (from === 'done' ? 1 : 0)) as -1 | 0 | 1;
  return { set, enteredTesting, failedTesting: leftTesting && to.category !== 'done', passedTesting: leftTesting && to.category === 'done', doneDelta };
}

/* ----------------------------------------------------------------- ordering */

interface Column {
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId;
  parentTaskId: Types.ObjectId | null;
  statusId: string;
}

/**
 * Computes a rank from neighbour ids (inside the caller's transaction). Neighbours must still be in the
 * target column, otherwise 409. If the rank would grow too long, the whole column is re-spaced.
 */
async function placeRank(
  col: Column,
  selfId: Types.ObjectId | null,
  afterId: string | null | undefined,
  beforeId: string | null | undefined,
  session: ClientSession,
): Promise<string> {
  const ids = [afterId, beforeId].filter((x): x is string => !!x).map(oid);
  const found = ids.length ? await taskRepository.findRanked(col.workspaceId, ids, session) : [];
  const pick = (id?: string | null): RankedTask | null => {
    if (!id) return null;
    const t = found.find((f) => f._id.equals(id));
    const inColumn = t && !sameId(t._id, selfId) && t.projectId.equals(col.projectId) && t.statusId === col.statusId && sameId(t.parentTaskId, col.parentTaskId);
    if (!inColumn) throw boardChanged();
    return t;
  };

  let prev = pick(afterId);
  let next = pick(beforeId);
  if (prev && !next) next = await taskRepository.neighbour(col, prev.rank, 1, selfId, session);
  else if (next && !prev) prev = await taskRepository.neighbour(col, next.rank, -1, selfId, session);
  else if (!prev && !next) prev = await taskRepository.neighbour(col, null, -1, selfId, session);

  let rank: string;
  try {
    rank = rankBetween(prev?.rank ?? null, next?.rank ?? null);
  } catch (err) {
    if (!(err instanceof RankOrderError)) throw err;
    // Two cards can share a rank after concurrent moves; re-spacing the column resolves it.
    if (!(prev && next && prev.rank === next.rank)) throw boardChanged();
    rank = '';
  }
  if (rank && rank.length <= REBALANCE_LENGTH) return rank;

  const ordered: (Types.ObjectId | null)[] = await taskRepository.columnIds(col, selfId, session);
  const at = prev ? ordered.findIndex((id) => id?.equals(prev._id)) + 1 : next ? ordered.findIndex((id) => id?.equals(next._id)) : ordered.length;
  ordered.splice(at, 0, null);
  const ranks = evenRanks(ordered.length);
  await taskRepository.setRanks(
    col.workspaceId,
    ordered.flatMap((id, i) => (id ? [{ id, rank: ranks[i]! }] : [])),
    session,
  );
  return ranks[at]!;
}

/* ------------------------------------------------------------ notifications */

type Notice =
  | { kind: 'assigned'; to: Types.ObjectId }
  | { kind: 'testRequested'; to: Types.ObjectId }
  | { kind: 'testFailed'; to: Types.ObjectId; note: string }
  | { kind: 'testPassed'; to: Types.ObjectId };

const NOTICE_TYPE = { assigned: 'task_assigned', testRequested: 'test_requested', testFailed: 'test_failed', testPassed: 'test_passed' } as const;

async function loadUsers(ctx: AuthContext, ids: (Types.ObjectId | null | undefined)[]): Promise<Users> {
  const unique = new Map<string, Types.ObjectId>();
  for (const id of ids) if (id) unique.set(id.toHexString(), id);
  if (!unique.size) return new Map();
  const users = await userRepository.findByIds(ctx.workspaceId, [...unique.values()]);
  return new Map(users.map((u) => [u._id.toHexString(), u]));
}

function peopleIds(t: ITask): (Types.ObjectId | null | undefined)[] {
  return [t.assigneeId, t.testerId, t.reporterId, t.testing?.sentBy, t.testing?.resultBy];
}

async function toDtos(ctx: AuthContext, tasks: ITask[]): Promise<TaskDto[]> {
  const people = await loadUsers(ctx, tasks.flatMap(peopleIds));
  return tasks.map((t) => toTaskDto(t, people));
}

const toDto = async (ctx: AuthContext, t: ITask) => (await toDtos(ctx, [t]))[0]!;

/**
 * Builds outbox notifications (in-app + email per the recipient's preferences). Nobody is notified about
 * their own action. Keys are per task version, so a retried transaction never notifies twice.
 */
function notify(ctx: AuthContext, task: ITask, project: IProject, notices: Notice[], users: Users): OutboxMessage[] {
  const actor = users.get(ctx.userId.toHexString());
  const out: OutboxMessage[] = [];
  for (const n of notices) {
    if (n.to.equals(ctx.userId)) continue;
    const job: NotifyJob = {
      workspaceId: ctx.workspaceId.toHexString(),
      userId: n.to.toHexString(),
      type: NOTICE_TYPE[n.kind],
      actor: actor ? { id: actor._id.toHexString(), name: actor.name } : null,
      projectId: project._id.toHexString(),
      projectName: project.name,
      subject: { type: 'task', id: task._id.toHexString(), key: task.key, title: task.title },
      note: n.kind === 'testFailed' ? n.note : n.kind === 'testRequested' ? (task.testing?.note ?? '') : '',
      ...(n.kind === 'testRequested' ? { round: task.testing?.round ?? 1 } : {}),
    };
    out.push(notifyMessage(job, `task:${task._id.toHexString()}:v${task.version}:${n.kind}:${n.to.toHexString()}`));
  }
  return out;
}

/** Tells everyone viewing the project to refresh this task. Called only after the transaction commits. */
function broadcast(ctx: AuthContext, task: Pick<ITask, '_id' | 'projectId' | 'parentTaskId' | 'statusCategory'>, kind: 'created' | 'updated' | 'moved' | 'deleted'): void {
  realtime.taskChanged({ projectId: task.projectId, taskId: task._id, parentTaskId: task.parentTaskId, kind, actorId: ctx.userId });
  bus.emit('task.changed', {
    workspaceId: ctx.workspaceId,
    projectId: task.projectId,
    taskId: task._id,
    kind,
    statusCategory: task.statusCategory,
    actorId: ctx.userId,
  });
}

/* ----------------------------------------------------------------- activity */

const PRIORITY_NAME = { none: 'None', low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' } as const;

function entry(ctx: AuthContext, task: Pick<ITask, '_id' | 'projectId' | 'key'>, action: string, changes: ActivityChange[] = []): ActivityEntry {
  return { workspaceId: ctx.workspaceId, projectId: task.projectId, entityType: 'task', entityId: task._id, entityKey: task.key, actorId: ctx.userId, action, changes };
}

const statusName = (a: Access, id: string) => a.project.workflow.taskStatuses.find((s) => s.id === id)?.name ?? id;
const personName = (users: Users, id: Types.ObjectId | null) => (id ? (users.get(id.toHexString())?.name ?? 'Removed user') : null);
const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Readable before/after values (names, not ids) for the fields an update touched. */
async function updateChanges(ctx: AuthContext, task: ITask, set: Record<string, unknown>, users: Users): Promise<ActivityChange[]> {
  const out: ActivityChange[] = [];
  const has = (k: string) => k in set;
  if (has('title') && set.title !== task.title) out.push({ field: 'title', from: task.title, to: set.title as string });
  if (has('description') && set.description !== task.description) out.push({ field: 'description', from: null, to: null });
  if (has('priority') && set.priority !== task.priority) out.push({ field: 'priority', from: PRIORITY_NAME[task.priority], to: PRIORITY_NAME[set.priority as ITask['priority']] });
  if (has('dueDate') && isoDate(set.dueDate as Date | null) !== isoDate(task.dueDate)) out.push({ field: 'due date', from: isoDate(task.dueDate), to: isoDate(set.dueDate as Date | null) });
  if (has('assigneeId')) out.push({ field: 'assignee', from: personName(users, task.assigneeId), to: personName(users, set.assigneeId as Types.ObjectId | null) });
  if (has('testerId')) out.push({ field: 'tester', from: personName(users, task.testerId), to: personName(users, set.testerId as Types.ObjectId | null) });
  if (has('labelIds')) {
    const next = set.labelIds as Types.ObjectId[];
    const same = next.length === task.labelIds.length && next.every((id) => task.labelIds.some((l) => l.equals(id)));
    if (!same) {
      const names = new Map((await labelRepository.listForProject(ctx.workspaceId, task.projectId)).map((l) => [l._id.toHexString(), l.name]));
      const list = (ids: Types.ObjectId[]) => ids.map((id) => names.get(id.toHexString()) ?? 'deleted label').join(', ') || null;
      out.push({ field: 'labels', from: list(task.labelIds), to: list(next) });
    }
  }
  return out;
}

/** Checklist edits are single atomic updates (no transaction), so their entries are written right after. */
async function recordChecklist(ctx: AuthContext, task: ITask, action: string, change: ActivityChange): Promise<void> {
  try {
    await recordActivity(null, entry(ctx, task, action, [change]));
  } catch (err) {
    logger.warn({ err, taskId: task._id }, 'failed to record checklist activity');
  }
}

/* ------------------------------------------------------------------ service */

export const tasksService = {
  async board(ctx: AuthContext, projectId: string): Promise<BoardDto> {
    const a = await projectsService.access(ctx, projectId);
    const tasks = await taskRepository.board(ctx.workspaceId, a.project._id, BOARD_LIMIT);
    const truncated = tasks.length > BOARD_LIMIT;
    return { tasks: await toDtos(ctx, truncated ? tasks.slice(0, BOARD_LIMIT) : tasks), truncated };
  },

  async list(ctx: AuthContext, q: ListTasksQuery): Promise<Page<TaskDto>> {
    const filter: FilterQuery<ITask> = { workspaceId: ctx.workspaceId };
    if (q.parentId) {
      filter.parentTaskId = (await loadWithAccess(ctx, q.parentId)).task._id;
    } else if (q.projectId) {
      filter.projectId = (await projectsService.access(ctx, q.projectId)).project._id;
    } else if (!hasRoleAtLeast(ctx.role, 'admin')) {
      const memberships = await memberRepository.listForUser(ctx.workspaceId, ctx.userId);
      const visible = await projectRepository.visibleIds(ctx.workspaceId, {
        memberOf: memberships.map((m) => m.projectId),
        includeWorkspaceVisible: ctx.role !== 'guest',
      });
      filter.projectId = { $in: visible };
    }

    if (q.assignee) filter.assigneeId = q.assignee === 'me' ? ctx.userId : oid(q.assignee);
    if (q.tester) filter.testerId = q.tester === 'me' ? ctx.userId : oid(q.tester);
    if (q.statusCategory) filter.statusCategory = q.statusCategory;
    else if (q.state === 'open') filter.statusCategory = { $ne: 'done' };
    else if (q.state === 'done') filter.statusCategory = 'done';
    if (q.priority) filter.priority = q.priority;
    if (q.labelId) filter.labelIds = oid(q.labelId);
    if (q.q) {
      if (taskKeySchema.safeParse(q.q).success) filter.key = q.q.toUpperCase();
      else filter.title = new RegExp(escapeRegex(q.q), 'i');
    }

    const sort = q.parentId
      ? ({ field: 'rank', direction: 1 } as const)
      : ({ updated: { field: 'updatedAt', direction: -1 }, created: { field: 'createdAt', direction: -1 }, priority: { field: 'priorityRank', direction: -1 } } as const)[q.sort];
    const page = await taskRepository.list(filter, sort, q.limit, q.cursor);
    return { items: await toDtos(ctx, page.items), nextCursor: page.nextCursor };
  },

  async get(ctx: AuthContext, id: string): Promise<TaskDto> {
    return toDto(ctx, (await loadWithAccess(ctx, id)).task);
  },

  async create(ctx: AuthContext, projectId: string, input: CreateTaskInput): Promise<TaskDto> {
    const a = await projectsService.access(ctx, projectId);
    assertWritable(a);
    const status = input.statusId ? findStatus(a, input.statusId) : initialStatus(a);
    const assigneeId = input.assigneeId ? oid(input.assigneeId) : null;
    const testerId = input.testerId ? oid(input.testerId) : null;
    const labelIds = uniqueIds(input.labelIds);

    if (status.category === 'testing' && !testerId) throw new ValidationError([{ path: 'testerId', message: 'Choose who will test this task' }]);
    assertTesterNotAssignee(assigneeId, testerId);
    const [joinAssignee, joinTester] = await Promise.all([
      assigneeId ? checkEligible(ctx, a, assigneeId, 'assigneeId') : null,
      testerId ? checkEligible(ctx, a, testerId, 'testerId') : null,
      assertLabels(ctx, a.project._id, labelIds),
    ]);

    let parent: ITask | null = null;
    if (input.parentTaskId) {
      parent = await taskRepository.findById(ctx.workspaceId, input.parentTaskId);
      if (!parent || !parent.projectId.equals(a.project._id)) throw new ValidationError([{ path: 'parentTaskId', message: 'Parent task not found in this project' }]);
      if (parent.parentTaskId) throw new ValidationError([{ path: 'parentTaskId', message: 'Subtasks cannot have subtasks of their own' }]);
    }

    const tr = transition(null, status, ctx.userId, testerId, undefined);
    const notices: Notice[] = [];
    if (assigneeId) notices.push({ kind: 'assigned', to: assigneeId });
    if (tr.enteredTesting && testerId) notices.push({ kind: 'testRequested', to: testerId });
    const users = await loadUsers(ctx, [ctx.userId, assigneeId, testerId]);
    const initial: ActivityChange[] = [{ field: 'status', from: null, to: status.name }];
    if (assigneeId) initial.push({ field: 'assignee', from: null, to: personName(users, assigneeId) });
    if (testerId) initial.push({ field: 'tester', from: null, to: personName(users, testerId) });

    const task = await withTransaction(async (session) => {
      await joinProject(ctx, a, [joinAssignee, joinTester], session);
      const number = await counterRepository.next(ctx.workspaceId, a.project._id, 'task', session);
      const col = { workspaceId: ctx.workspaceId, projectId: a.project._id, parentTaskId: parent?._id ?? null, statusId: status.id };
      const rank = await placeRank(col, null, null, null, session);
      const created = await taskRepository.create(
        {
          workspaceId: ctx.workspaceId,
          projectId: a.project._id,
          number,
          key: `${a.project.key}-${number}`,
          title: input.title,
          description: input.description,
          priority: input.priority,
          priorityRank: PRIORITY_RANK[input.priority],
          assigneeId,
          testerId,
          reporterId: ctx.userId,
          labelIds,
          dueDate: toDate(input.dueDate),
          parentTaskId: parent?._id ?? null,
          rank,
          ...tr.set,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        } as Partial<ITask>,
        session,
      );
      if (parent) await taskRepository.adjustSubtaskCounts(ctx.workspaceId, parent._id, { subtasks: 1, subtasksDone: tr.doneDelta }, session);
      await recordActivity(session, entry(ctx, created, 'created', initial));
      await enqueue(session, notify(ctx, created, a.project, notices, users));
      return created;
    });
    broadcast(ctx, task, 'created');
    return toDto(ctx, task);
  },

  async update(ctx: AuthContext, id: string, input: UpdateTaskInput, expectedVersion: number): Promise<TaskDto> {
    const { task, a } = await loadWithAccess(ctx, id);
    assertWritable(a);

    const set: Record<string, unknown> = { updatedBy: ctx.userId };
    if (input.title !== undefined) set.title = input.title;
    if (input.description !== undefined) set.description = input.description;
    if (input.priority !== undefined) {
      set.priority = input.priority;
      set.priorityRank = PRIORITY_RANK[input.priority];
    }
    if (input.dueDate !== undefined) set.dueDate = toDate(input.dueDate);
    if (input.labelIds !== undefined) {
      const labelIds = uniqueIds(input.labelIds);
      await assertLabels(ctx, a.project._id, labelIds);
      set.labelIds = labelIds;
    }

    const nextAssignee = input.assigneeId === undefined ? task.assigneeId : input.assigneeId ? oid(input.assigneeId) : null;
    const nextTester = input.testerId === undefined ? task.testerId : input.testerId ? oid(input.testerId) : null;
    const assigneeChanged = !sameId(task.assigneeId, nextAssignee);
    const testerChanged = !sameId(task.testerId, nextTester);
    const joins: (Types.ObjectId | null)[] = [];
    if (assigneeChanged) {
      if (nextAssignee) joins.push(await checkEligible(ctx, a, nextAssignee, 'assigneeId'));
      set.assigneeId = nextAssignee;
    }
    if (testerChanged) {
      // Otherwise anyone could make themselves tester and then sign the task off.
      if (task.statusCategory === 'testing' && !sameId(task.testerId, ctx.userId) && !a.canManage) {
        throw new ForbiddenError('Only the tester or a project lead can change the tester during testing');
      }
      if (nextTester) joins.push(await checkEligible(ctx, a, nextTester, 'testerId'));
      else if (task.statusCategory === 'testing') throw new ValidationError([{ path: 'testerId', message: 'A task in testing needs a tester' }]);
      set.testerId = nextTester;
    }
    if (assigneeChanged || testerChanged) assertTesterNotAssignee(nextAssignee, nextTester);

    const notices: Notice[] = [];
    if (assigneeChanged && nextAssignee) notices.push({ kind: 'assigned', to: nextAssignee });
    if (testerChanged && nextTester && task.statusCategory === 'testing') notices.push({ kind: 'testRequested', to: nextTester });
    const users = await loadUsers(ctx, [ctx.userId, task.assigneeId, nextAssignee, task.testerId, nextTester]);
    const changes = await updateChanges(ctx, task, set, users);

    const updated = await withTransaction(async (session) => {
      await joinProject(ctx, a, joins, session);
      const doc = await taskRepository.update(ctx.workspaceId, task._id, expectedVersion, { $set: set }, session);
      if (changes.length) await recordActivity(session, entry(ctx, doc, 'updated', changes));
      await enqueue(session, notify(ctx, doc, a.project, notices, users));
      return doc;
    });
    broadcast(ctx, updated, 'updated');
    return toDto(ctx, updated);
  },

  async move(ctx: AuthContext, id: string, input: MoveTaskInput, expectedVersion: number): Promise<TaskDto> {
    const { task, a } = await loadWithAccess(ctx, id);
    assertWritable(a);
    const to = findStatus(a, input.statusId);
    const statusChanged = to.id !== task.statusId;
    const entering = statusChanged && to.category === 'testing' && task.statusCategory !== 'testing';
    const leaving = statusChanged && task.statusCategory === 'testing' && to.category !== 'testing';

    if (leaving && !sameId(task.testerId, ctx.userId) && !a.canManage) {
      throw new ForbiddenError('Only the tester or a project lead can finish testing');
    }
    let testerId = task.testerId;
    let joinTester: Types.ObjectId | null = null;
    if (entering) {
      if (input.testerId) testerId = oid(input.testerId);
      if (!testerId) throw new ValidationError([{ path: 'testerId', message: 'Choose who will test this task' }]);
      assertTesterNotAssignee(task.assigneeId, testerId);
      joinTester = await checkEligible(ctx, a, testerId, 'testerId');
    }

    const col = { workspaceId: ctx.workspaceId, projectId: task.projectId, parentTaskId: task.parentTaskId, statusId: to.id };
    const tr = statusChanged ? transition(task, to, ctx.userId, testerId, input.note) : null;

    const notices: Notice[] = [];
    if (tr?.enteredTesting && testerId) notices.push({ kind: 'testRequested', to: testerId });
    if (tr?.failedTesting && task.assigneeId) notices.push({ kind: 'testFailed', to: task.assigneeId, note: input.note ?? '' });
    if (tr?.passedTesting && task.assigneeId) notices.push({ kind: 'testPassed', to: task.assigneeId });
    const users = await loadUsers(ctx, [ctx.userId, task.testerId, testerId]);
    // Reordering within a column is placement, not history: only status changes are logged.
    const moved: ActivityChange[] = [];
    if (statusChanged) moved.push({ field: 'status', from: statusName(a, task.statusId), to: to.name });
    if (entering && !sameId(task.testerId, testerId)) moved.push({ field: 'tester', from: personName(users, task.testerId), to: personName(users, testerId) });
    if (statusChanged && input.note) moved.push({ field: 'note', from: null, to: input.note });

    const updated = await withTransaction(async (session) => {
      await joinProject(ctx, a, [joinTester], session);
      const rank = await placeRank(col, task._id, input.afterId, input.beforeId, session);
      const doc = await taskRepository.update(ctx.workspaceId, task._id, expectedVersion, { $set: { rank, updatedBy: ctx.userId, ...tr?.set } }, session);
      if (task.parentTaskId && tr?.doneDelta) await taskRepository.adjustSubtaskCounts(ctx.workspaceId, task.parentTaskId, { subtasksDone: tr.doneDelta }, session);
      if (moved.length) await recordActivity(session, entry(ctx, doc, 'moved', moved));
      await enqueue(session, notify(ctx, doc, a.project, notices, users));
      return doc;
    });
    broadcast(ctx, updated, 'moved');
    return toDto(ctx, updated);
  },

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const { task, a } = await loadWithAccess(ctx, id);
    assertWritable(a);
    const allowed = a.canManage || hasRoleAtLeast(ctx.role, 'manager') || task.reporterId.equals(ctx.userId);
    if (!allowed) throw new ForbiddenError('Only the reporter, a project lead or a manager can delete this task');

    await withTransaction(async (session) => {
      const subtasks = task.parentTaskId ? [] : await taskRepository.subtaskIds(ctx.workspaceId, task._id, session);
      const deleted = await taskRepository.softDelete(ctx.workspaceId, [task._id, ...subtasks.map((s) => s._id)], ctx.userId, session);
      if (deleted === 0) throw new NotFoundError('Task');
      await recordActivity(session, entry(ctx, task, 'deleted', subtasks.length ? [{ field: 'subtasks', from: null, to: `${subtasks.length} deleted` }] : []));
      if (task.parentTaskId) {
        await taskRepository.adjustSubtaskCounts(
          ctx.workspaceId,
          task.parentTaskId,
          { subtasks: -1, subtasksDone: task.statusCategory === 'done' ? -1 : 0 },
          session,
        );
      }
    });
    broadcast(ctx, task, 'deleted');
  },

  async addChecklistItem(ctx: AuthContext, id: string, text: string): Promise<TaskDto> {
    const { task, a } = await loadWithAccess(ctx, id);
    assertWritable(a);
    const updated = await taskRepository.pushChecklistItem(ctx.workspaceId, task._id, { text }, ctx.userId);
    if (!updated) throw new ConflictError('This checklist is full (100 items)');
    await recordChecklist(ctx, updated, 'checklist_added', { field: 'checklist', from: null, to: text });
    broadcast(ctx, updated, 'updated');
    return toDto(ctx, updated);
  },

  async updateChecklistItem(ctx: AuthContext, id: string, itemId: string, set: { text?: string | undefined; done?: boolean | undefined }): Promise<TaskDto> {
    const { task, a } = await loadWithAccess(ctx, id);
    assertWritable(a);
    const clean = Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined)) as { text?: string; done?: boolean };
    const updated = await taskRepository.setChecklistItem(ctx.workspaceId, task._id, oid(itemId), clean, ctx.userId);
    if (!updated) throw new NotFoundError('Checklist item');
    const before = task.checklist.find((i) => i._id.equals(itemId));
    const after = updated.checklist.find((i) => i._id.equals(itemId));
    if (before && after && before.text !== after.text) await recordChecklist(ctx, updated, 'checklist_edited', { field: 'checklist', from: before.text, to: after.text });
    if (after && before?.done !== after.done) await recordChecklist(ctx, updated, after.done ? 'checklist_checked' : 'checklist_unchecked', { field: 'checklist', from: null, to: after.text });
    broadcast(ctx, updated, 'updated');
    return toDto(ctx, updated);
  },

  async removeChecklistItem(ctx: AuthContext, id: string, itemId: string): Promise<TaskDto> {
    const { task, a } = await loadWithAccess(ctx, id);
    assertWritable(a);
    const updated = await taskRepository.pullChecklistItem(ctx.workspaceId, task._id, oid(itemId), ctx.userId);
    if (!updated) throw new NotFoundError('Checklist item');
    const removed = task.checklist.find((i) => i._id.equals(itemId));
    if (removed) await recordChecklist(ctx, updated, 'checklist_removed', { field: 'checklist', from: removed.text, to: null });
    broadcast(ctx, updated, 'updated');
    return toDto(ctx, updated);
  },

  async listLabels(ctx: AuthContext, projectId: string): Promise<LabelDto[]> {
    const a = await projectsService.access(ctx, projectId);
    return (await labelRepository.listForProject(ctx.workspaceId, a.project._id)).map(toLabelDto);
  },

  async createLabel(ctx: AuthContext, projectId: string, input: CreateLabelInput): Promise<LabelDto> {
    const a = await projectsService.access(ctx, projectId);
    assertWritable(a);
    try {
      return toLabelDto(await labelRepository.create({ workspaceId: ctx.workspaceId, projectId: a.project._id, ...input, createdBy: ctx.userId }));
    } catch (err) {
      if (isDuplicateKey(err)) throw new ConflictError(`A label named "${input.name}" already exists`);
      throw err;
    }
  },

  async removeLabel(ctx: AuthContext, projectId: string, labelId: string): Promise<void> {
    const a = await projectsService.access(ctx, projectId);
    if (!a.canManage) throw new ForbiddenError('Only project leads and admins can delete labels');
    await withTransaction(async (session) => {
      if (!(await labelRepository.remove(ctx.workspaceId, a.project._id, oid(labelId), session))) throw new NotFoundError('Label');
      await taskRepository.pullLabel(ctx.workspaceId, oid(labelId), session);
    });
  },
};
