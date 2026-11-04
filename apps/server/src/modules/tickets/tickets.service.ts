import { Types, type ClientSession, type FilterQuery } from 'mongoose';
import {
  hasRoleAtLeast,
  MAX_TICKET_LINKED_TASKS,
  SEVERITY_RANK,
  ticketKeySchema,
  type ConvertTicketResultDto,
  type CreateTicketInput,
  type ListTicketsQuery,
  type MoveTicketInput,
  type Page,
  type TaskPriority,
  type TicketBoardDto,
  type TicketDto,
  type TicketResolution,
  type TicketSeverity,
  type UpdateTicketInput,
} from '@teamtrack/shared';
import { withTransaction } from '../../db/transaction';
import { evenRanks, rankBetween, RankOrderError, REBALANCE_LENGTH } from '../../db/rank';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors/AppError';
import type { AuthContext } from '../../auth/context';
import type { IProject, IWorkflowStatus } from '../../models/Project';
import type { ITicket } from '../../models/Ticket';
import { labelRepository, taskRepository } from '../../repositories/taskRepository';
import { memberRepository, projectRepository } from '../../repositories/projectRepository';
import { userRepository } from '../../repositories/userRepository';
import { enqueue, type OutboxMessage } from '../../services/outbox';
import { notifyMessage, type NotifyJob } from '../../services/notifier';
import { realtime } from '../../services/realtime';
import { recordActivity, type ActivityChange } from '../../services/activity';
import { bus } from '../../events/bus';
import { projectsService } from '../projects/projects.service';
import { tasksService } from '../tasks/tasks.service';
import { ticketCounterRepository, ticketRepository, type RankedTicket, type TicketColumn } from './ticketRepository';
import { loadUsers, personRef, ticketPath, toTicketDtoOne, toTicketDtos, type Users } from './tickets.mapper';

type Access = Awaited<ReturnType<typeof projectsService.access>>;
type ChangeKind = 'created' | 'updated' | 'moved' | 'deleted';

const BOARD_LIMIT = 1000;
const oid = (id: string) => new Types.ObjectId(id);
const sameId = (a: Types.ObjectId | null | undefined, b: Types.ObjectId | null | undefined) => (a && b ? a.equals(b) : !a && !b);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uniqueIds = (ids: string[]) => [...new Set(ids)].map(oid);
const boardChanged = () => new ConflictError('The board changed while you were moving this card. Refresh and try again.');

export const RESOLUTION_LABEL: Record<TicketResolution, string> = {
  fixed: 'Fixed',
  wont_fix: "Won't fix",
  duplicate: 'Duplicate',
  cannot_reproduce: 'Cannot reproduce',
  by_design: 'By design',
};

/** Severity to task priority, for "convert to task". */
const PRIORITY_OF: Record<TicketSeverity, TaskPriority> = { low: 'low', medium: 'medium', high: 'high', critical: 'urgent' };

/* ------------------------------------------------------------------ guards */

function assertWritable(a: Access): void {
  if (!a.canEdit) throw new ForbiddenError('You can view this project but not change its tickets');
  if (a.project.status === 'archived') throw new ConflictError('This project is archived. Restore it to make changes.');
}

/** Loads a ticket and checks the caller can see its project (404 for both "missing" and "not visible"). */
async function loadWithAccess(ctx: AuthContext, id: string): Promise<{ ticket: ITicket; a: Access }> {
  const ticket = await ticketRepository.findById(ctx.workspaceId, id);
  if (!ticket) throw new NotFoundError('Ticket');
  try {
    return { ticket, a: await projectsService.access(ctx, ticket.projectId) };
  } catch (err) {
    if (err instanceof NotFoundError) throw new NotFoundError('Ticket');
    throw err;
  }
}

function findStatus(a: Access, statusId: string): IWorkflowStatus {
  const status = a.project.workflow.ticketStatuses.find((s) => s.id === statusId);
  if (!status) throw new ValidationError([{ path: 'statusId', message: 'Not a ticket status of this project' }]);
  return status;
}

function initialStatus(a: Access): IWorkflowStatus {
  return [...a.project.workflow.ticketStatuses].sort((x, y) => x.order - y.order)[0]!;
}

/** Assignees are active leads or members of the project. Unlike tasks, assigning never adds anyone. */
async function assertAssignable(ctx: AuthContext, a: Access, userId: Types.ObjectId): Promise<void> {
  const fail = (message: string) => new ValidationError([{ path: 'assigneeId', message }]);
  const [membership, user] = await Promise.all([
    memberRepository.find(ctx.workspaceId, a.project._id, userId),
    userRepository.findById(ctx.workspaceId, userId),
  ]);
  if (!user || user.status !== 'active') throw fail('The assignee must be an active member of this workspace');
  if (!membership) throw fail(`${user.name} isn't in this project`);
  if (membership.role === 'viewer') throw fail(`${user.name} is a viewer on this project and can't be the assignee`);
}

async function assertLabels(ctx: AuthContext, projectId: Types.ObjectId, ids: Types.ObjectId[]): Promise<void> {
  if (ids.length && (await labelRepository.countInProject(ctx.workspaceId, projectId, ids)) !== ids.length) {
    throw new ValidationError([{ path: 'labelIds', message: 'One or more labels do not belong to this project' }]);
  }
}

/** A duplicate must point at another live ticket of the same project. */
async function checkDuplicateOf(ctx: AuthContext, ticket: Pick<ITicket, '_id' | 'projectId'>, id: string): Promise<Types.ObjectId> {
  const original = await ticketRepository.findById(ctx.workspaceId, id);
  if (!original || original._id.equals(ticket._id) || !original.projectId.equals(ticket.projectId)) {
    throw new ValidationError([{ path: 'duplicateOfId', message: 'Choose another ticket of this project' }]);
  }
  return original._id;
}

/* ------------------------------------------------------------- transitions */

interface Transition {
  set: Record<string, unknown>;
  inc: Record<string, number>;
  resolved: boolean;
  reopened: boolean;
}

/**
 * The single place ticket status changes are interpreted. Entering a done-category status requires a
 * resolution and stamps resolvedAt; leaving one reopens the ticket: resolution cleared, reopenCount + 1.
 */
function transition(
  prev: Pick<ITicket, 'statusCategory' | 'resolution'>,
  to: IWorkflowStatus,
  actorId: Types.ObjectId,
  resolution: TicketResolution | undefined,
  duplicateOfId: Types.ObjectId | null,
): Transition {
  const fromDone = prev.statusCategory === 'done';
  const toDone = to.category === 'done';
  const set: Record<string, unknown> = { statusId: to.id, statusCategory: to.category };
  const inc: Record<string, number> = {};

  if (!toDone && (resolution || duplicateOfId)) {
    throw new ValidationError([{ path: 'resolution', message: 'Only resolved tickets have a resolution' }]);
  }
  if (toDone && !fromDone && !resolution) {
    throw new ValidationError([{ path: 'resolution', message: 'Choose a resolution' }]);
  }
  const next = resolution ?? prev.resolution;
  if (duplicateOfId && next !== 'duplicate') {
    throw new ValidationError([{ path: 'duplicateOfId', message: 'Only duplicates point at another ticket' }]);
  }

  if (toDone && !fromDone) {
    Object.assign(set, { resolution, duplicateOfId, resolvedAt: new Date(), resolvedBy: actorId });
  } else if (toDone) {
    // Moving between done statuses (Resolved -> Closed) may refine the resolution.
    if (resolution) set.resolution = resolution;
    if (duplicateOfId) set.duplicateOfId = duplicateOfId;
    else if (next !== 'duplicate') set.duplicateOfId = null;
  } else if (!toDone && fromDone) {
    Object.assign(set, { resolution: null, duplicateOfId: null, resolvedAt: null, resolvedBy: null });
    inc.reopenCount = 1;
  }
  return { set, inc, resolved: toDone && !fromDone, reopened: fromDone && !toDone };
}

/* ----------------------------------------------------------------- ordering */

/**
 * Computes a rank from neighbour ids (inside the caller's transaction). Neighbours must still be in the
 * target column, otherwise 409. If the rank would grow too long, the whole column is re-spaced.
 * Same algorithm as tasks.service placeRank.
 */
async function placeRank(
  col: TicketColumn,
  selfId: Types.ObjectId | null,
  afterId: string | null | undefined,
  beforeId: string | null | undefined,
  session: ClientSession,
): Promise<string> {
  const ids = [afterId, beforeId].filter((x): x is string => !!x).map(oid);
  const found = ids.length ? await ticketRepository.findRanked(col.workspaceId, ids, session) : [];
  const pick = (id?: string | null): RankedTicket | null => {
    if (!id) return null;
    const t = found.find((f) => f._id.equals(id));
    const inColumn = t && !sameId(t._id, selfId) && t.projectId.equals(col.projectId) && t.statusId === col.statusId;
    if (!inColumn) throw boardChanged();
    return t;
  };

  let prev = pick(afterId);
  let next = pick(beforeId);
  if (prev && !next) next = await ticketRepository.neighbour(col, prev.rank, 1, selfId, session);
  else if (next && !prev) prev = await ticketRepository.neighbour(col, next.rank, -1, selfId, session);
  else if (!prev && !next) prev = await ticketRepository.neighbour(col, null, -1, selfId, session);

  let rank: string;
  try {
    rank = rankBetween(prev?.rank ?? null, next?.rank ?? null);
  } catch (err) {
    if (!(err instanceof RankOrderError)) throw err;
    if (!(prev && next && prev.rank === next.rank)) throw boardChanged();
    rank = '';
  }
  if (rank && rank.length <= REBALANCE_LENGTH) return rank;

  const ordered: (Types.ObjectId | null)[] = await ticketRepository.columnIds(col, selfId, session);
  const at = prev ? ordered.findIndex((id) => id?.equals(prev._id)) + 1 : next ? ordered.findIndex((id) => id?.equals(next._id)) : ordered.length;
  ordered.splice(at, 0, null);
  const ranks = evenRanks(ordered.length);
  await ticketRepository.setRanks(
    col.workspaceId,
    ordered.flatMap((id, i) => (id ? [{ id, rank: ranks[i]! }] : [])),
    session,
  );
  return ranks[at]!;
}

/* ------------------------------------------------------- side effects */

type Notice = { kind: 'assigned'; to: Types.ObjectId } | { kind: 'resolved'; to: Types.ObjectId; note: string };

const NOTICE_TYPE = { assigned: 'ticket_assigned', resolved: 'ticket_resolved' } as const;

/**
 * Outbox notifications. Nobody is notified about their own action. Keys are per ticket version, so a
 * retried transaction never notifies twice.
 */
function notify(ctx: AuthContext, ticket: ITicket, project: IProject, notices: Notice[], users: Users): OutboxMessage[] {
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
      subject: { type: 'ticket', id: ticket._id.toHexString(), key: ticket.key, title: ticket.title },
      path: ticketPath(ticket._id.toHexString()),
      note: n.kind === 'resolved' ? n.note : '',
    };
    out.push(notifyMessage(job, `ticket:${ticket._id.toHexString()}:v${ticket.version}:${n.kind}:${n.to.toHexString()}`));
  }
  return out;
}

const resolvedNote = (resolution: TicketResolution, note: string | undefined) => (note ? `${RESOLUTION_LABEL[resolution]}: ${note}` : RESOLUTION_LABEL[resolution]);

function activity(ctx: AuthContext, t: Pick<ITicket, '_id' | 'projectId' | 'key'>, action: string, changes?: ActivityChange[]) {
  return {
    workspaceId: ctx.workspaceId,
    projectId: t.projectId,
    entityType: 'ticket' as const,
    entityId: t._id,
    entityKey: t.key,
    actorId: ctx.userId,
    action,
    ...(changes?.length ? { changes } : {}),
  };
}

const nameOf = (users: Users, id: Types.ObjectId | null) => (id ? (personRef(users, id)?.name ?? null) : null);
const statusName = (a: Access, id: string) => a.project.workflow.ticketStatuses.find((s) => s.id === id)?.name ?? id;

/** Tells everyone viewing the project to refresh this ticket. Called only after the transaction commits. */
function broadcast(ctx: AuthContext, t: Pick<ITicket, '_id' | 'projectId'>, kind: ChangeKind): void {
  realtime.toProject(t.projectId.toHexString(), 'ticket:changed', {
    projectId: t.projectId.toHexString(),
    ticketId: t._id.toHexString(),
    kind,
    actorId: ctx.userId.toHexString(),
  });
  bus.emit('ticket.changed', { workspaceId: ctx.workspaceId, projectId: t.projectId, ticketId: t._id, kind, actorId: ctx.userId });
}

/** Description for a task created from a ticket: the ticket's text plus its reproduction details. */
function taskDescriptionFrom(t: ITicket): string {
  const parts = [t.description.trim()];
  if (t.stepsToReproduce.trim()) parts.push(`Steps to reproduce:\n${t.stepsToReproduce.trim()}`);
  if (t.expected.trim()) parts.push(`Expected:\n${t.expected.trim()}`);
  if (t.actual.trim()) parts.push(`Actual:\n${t.actual.trim()}`);
  parts.push(`From ticket ${t.key}.`);
  return parts.filter(Boolean).join('\n\n').slice(0, 20_000);
}

/* ------------------------------------------------------------------ service */

export const ticketsService = {
  async board(ctx: AuthContext, projectId: string): Promise<TicketBoardDto> {
    const a = await projectsService.access(ctx, projectId);
    const tickets = await ticketRepository.board(ctx.workspaceId, a.project._id, BOARD_LIMIT);
    const truncated = tickets.length > BOARD_LIMIT;
    return { tickets: await toTicketDtos(ctx, truncated ? tickets.slice(0, BOARD_LIMIT) : tickets), truncated };
  },

  async list(ctx: AuthContext, q: ListTicketsQuery): Promise<Page<TicketDto>> {
    const filter: FilterQuery<ITicket> = { workspaceId: ctx.workspaceId };
    if (q.projectId) {
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
    if (q.reporter) filter.reporterId = q.reporter === 'me' ? ctx.userId : oid(q.reporter);
    if (q.state === 'open') filter.statusCategory = { $ne: 'done' };
    else if (q.state === 'done') filter.statusCategory = 'done';
    if (q.statusId) filter.statusId = q.statusId;
    if (q.type) filter.type = q.type;
    if (q.severity) filter.severity = q.severity;
    if (q.q) {
      if (ticketKeySchema.safeParse(q.q).success) filter.key = q.q.toUpperCase();
      else filter.title = new RegExp(escapeRegex(q.q), 'i');
    }

    const sort = (
      { updated: { field: 'updatedAt', direction: -1 }, created: { field: 'createdAt', direction: -1 }, severity: { field: 'severityRank', direction: -1 } } as const
    )[q.sort];
    const page = await ticketRepository.list(filter, sort, q.limit, q.cursor);
    return { items: await toTicketDtos(ctx, page.items), nextCursor: page.nextCursor };
  },

  async get(ctx: AuthContext, id: string): Promise<TicketDto> {
    return toTicketDtoOne(ctx, (await loadWithAccess(ctx, id)).ticket);
  },

  async create(ctx: AuthContext, projectId: string, input: CreateTicketInput): Promise<TicketDto> {
    const a = await projectsService.access(ctx, projectId);
    assertWritable(a);
    const status = input.statusId ? findStatus(a, input.statusId) : initialStatus(a);
    if (status.category === 'done') throw new ValidationError([{ path: 'statusId', message: 'New tickets start open' }]);
    const assigneeId = input.assigneeId ? oid(input.assigneeId) : null;
    const labelIds = uniqueIds(input.labelIds);
    await Promise.all([assigneeId ? assertAssignable(ctx, a, assigneeId) : null, assertLabels(ctx, a.project._id, labelIds)]);

    const notices: Notice[] = assigneeId ? [{ kind: 'assigned', to: assigneeId }] : [];
    const users = await loadUsers(ctx, [ctx.userId, assigneeId]);

    const ticket = await withTransaction(async (session) => {
      const number = await ticketCounterRepository.next(ctx.workspaceId, session);
      const rank = await placeRank({ workspaceId: ctx.workspaceId, projectId: a.project._id, statusId: status.id }, null, null, null, session);
      const created = await ticketRepository.create(
        {
          workspaceId: ctx.workspaceId,
          projectId: a.project._id,
          number,
          key: `TCK-${number}`,
          title: input.title,
          description: input.description,
          type: input.type,
          severity: input.severity,
          severityRank: SEVERITY_RANK[input.severity],
          statusId: status.id,
          statusCategory: status.category,
          assigneeId,
          reporterId: ctx.userId,
          environment: { browser: '', os: '', url: '', version: '', ...input.environment },
          stepsToReproduce: input.stepsToReproduce,
          expected: input.expected,
          actual: input.actual,
          labelIds,
          rank,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        } as Partial<ITicket>,
        session,
      );
      await recordActivity(
        session,
        activity(ctx, created, 'created'),
        ...(assigneeId ? [activity(ctx, created, 'assigned', [{ field: 'assignee', from: null, to: nameOf(users, assigneeId) }])] : []),
      );
      await enqueue(session, notify(ctx, created, a.project, notices, users));
      return created;
    });
    broadcast(ctx, ticket, 'created');
    return toTicketDtoOne(ctx, ticket);
  },

  async update(ctx: AuthContext, id: string, input: UpdateTicketInput, expectedVersion: number): Promise<TicketDto> {
    const { ticket, a } = await loadWithAccess(ctx, id);
    assertWritable(a);

    const set: Record<string, unknown> = { updatedBy: ctx.userId };
    const changes: ActivityChange[] = [];
    const track = (field: string, from: string | null, to: string | null) => from !== to && changes.push({ field, from, to });

    if (input.title !== undefined) {
      set.title = input.title;
      track('title', ticket.title, input.title);
    }
    if (input.type !== undefined) {
      set.type = input.type;
      track('type', ticket.type, input.type);
    }
    if (input.severity !== undefined) {
      set.severity = input.severity;
      set.severityRank = SEVERITY_RANK[input.severity];
      track('severity', ticket.severity, input.severity);
    }
    // Long text: record that it changed, not the text itself.
    for (const field of ['description', 'stepsToReproduce', 'expected', 'actual'] as const) {
      if (input[field] !== undefined && input[field] !== ticket[field]) {
        set[field] = input[field];
        changes.push({ field, from: null, to: null });
      }
    }
    if (input.environment !== undefined) {
      set.environment = { browser: '', os: '', url: '', version: '', ...input.environment };
      changes.push({ field: 'environment', from: null, to: null });
    }
    if (input.labelIds !== undefined) {
      const labelIds = uniqueIds(input.labelIds);
      await assertLabels(ctx, a.project._id, labelIds);
      set.labelIds = labelIds;
      track('labels', String(ticket.labelIds.length), String(labelIds.length));
    }

    // Resolution details can be corrected while resolved; reopening goes through move().
    if (input.resolution !== undefined || input.duplicateOfId !== undefined) {
      if (ticket.statusCategory !== 'done') throw new ValidationError([{ path: 'resolution', message: 'Only resolved tickets have a resolution' }]);
      const resolution = input.resolution ?? ticket.resolution;
      let duplicateOfId = input.duplicateOfId === undefined ? ticket.duplicateOfId : input.duplicateOfId ? await checkDuplicateOf(ctx, ticket, input.duplicateOfId) : null;
      if (resolution !== 'duplicate') {
        if (input.duplicateOfId) throw new ValidationError([{ path: 'duplicateOfId', message: 'Only duplicates point at another ticket' }]);
        duplicateOfId = null;
      }
      set.resolution = resolution;
      set.duplicateOfId = duplicateOfId;
      track('resolution', ticket.resolution, resolution);
    }

    const nextAssignee = input.assigneeId === undefined ? ticket.assigneeId : input.assigneeId ? oid(input.assigneeId) : null;
    const assigneeChanged = !sameId(ticket.assigneeId, nextAssignee);
    if (assigneeChanged) {
      if (nextAssignee) await assertAssignable(ctx, a, nextAssignee);
      set.assigneeId = nextAssignee;
    }

    const notices: Notice[] = assigneeChanged && nextAssignee ? [{ kind: 'assigned', to: nextAssignee }] : [];
    const users = await loadUsers(ctx, [ctx.userId, ticket.assigneeId, nextAssignee]);

    const updated = await withTransaction(async (session) => {
      const doc = await ticketRepository.update(ctx.workspaceId, ticket._id, expectedVersion, { $set: set }, session);
      await recordActivity(
        session,
        ...(changes.length ? [activity(ctx, doc, 'updated', changes)] : []),
        ...(assigneeChanged
          ? [activity(ctx, doc, 'assigned', [{ field: 'assignee', from: nameOf(users, ticket.assigneeId), to: nameOf(users, nextAssignee) }])]
          : []),
      );
      await enqueue(session, notify(ctx, doc, a.project, notices, users));
      return doc;
    });
    broadcast(ctx, updated, 'updated');
    return toTicketDtoOne(ctx, updated);
  },

  async move(ctx: AuthContext, id: string, input: MoveTicketInput, expectedVersion: number): Promise<TicketDto> {
    const { ticket, a } = await loadWithAccess(ctx, id);
    assertWritable(a);
    const to = findStatus(a, input.statusId);
    const statusChanged = to.id !== ticket.statusId;
    if (!statusChanged && (input.resolution || input.duplicateOfId)) {
      throw new ValidationError([{ path: 'resolution', message: 'Change the resolution from the ticket instead' }]);
    }
    const duplicateOfId = input.duplicateOfId ? await checkDuplicateOf(ctx, ticket, input.duplicateOfId) : null;
    const tr = statusChanged ? transition(ticket, to, ctx.userId, input.resolution, duplicateOfId) : null;

    const notices: Notice[] = [];
    if (tr?.resolved) notices.push({ kind: 'resolved', to: ticket.reporterId, note: resolvedNote(input.resolution!, input.note) });
    const users = await loadUsers(ctx, [ctx.userId]);
    const col = { workspaceId: ctx.workspaceId, projectId: ticket.projectId, statusId: to.id };

    const updated = await withTransaction(async (session) => {
      const rank = await placeRank(col, ticket._id, input.afterId, input.beforeId, session);
      const update = { $set: { rank, updatedBy: ctx.userId, ...tr?.set }, ...(tr && Object.keys(tr.inc).length ? { $inc: tr.inc } : {}) };
      const doc = await ticketRepository.update(ctx.workspaceId, ticket._id, expectedVersion, update, session);
      if (tr) {
        const changes: ActivityChange[] = [{ field: 'status', from: statusName(a, ticket.statusId), to: to.name }];
        if (doc.resolution !== ticket.resolution) {
          changes.push({ field: 'resolution', from: ticket.resolution && RESOLUTION_LABEL[ticket.resolution], to: doc.resolution && RESOLUTION_LABEL[doc.resolution] });
        }
        await recordActivity(session, activity(ctx, doc, tr.reopened ? 'reopened' : tr.resolved ? 'resolved' : 'moved', changes));
      }
      await enqueue(session, notify(ctx, doc, a.project, notices, users));
      return doc;
    });
    broadcast(ctx, updated, 'moved');
    return toTicketDtoOne(ctx, updated);
  },

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const { ticket, a } = await loadWithAccess(ctx, id);
    assertWritable(a);
    const allowed = a.canManage || hasRoleAtLeast(ctx.role, 'manager') || ticket.reporterId.equals(ctx.userId);
    if (!allowed) throw new ForbiddenError('Only the reporter, a project lead or a manager can delete this ticket');

    await withTransaction(async (session) => {
      if (!(await ticketRepository.softDelete(ctx.workspaceId, ticket._id, ctx.userId, session))) throw new NotFoundError('Ticket');
      await recordActivity(session, activity(ctx, ticket, 'deleted'));
    });
    broadcast(ctx, ticket, 'deleted');
  },

  async linkTask(ctx: AuthContext, id: string, taskId: string): Promise<TicketDto> {
    const { ticket, a } = await loadWithAccess(ctx, id);
    assertWritable(a);
    const task = await taskRepository.findById(ctx.workspaceId, taskId);
    if (!task || !task.projectId.equals(ticket.projectId)) throw new ValidationError([{ path: 'taskId', message: 'Choose a task of this project' }]);
    if (ticket.linkedTaskIds.some((x) => x.equals(task._id))) return toTicketDtoOne(ctx, ticket);

    const updated = await withTransaction(async (session) => {
      const doc = await ticketRepository.addLink(ctx.workspaceId, ticket._id, task._id, ctx.userId, session);
      if (!doc) throw new ConflictError(`A ticket can link at most ${MAX_TICKET_LINKED_TASKS} tasks`);
      await recordActivity(session, activity(ctx, doc, 'linked', [{ field: 'task', from: null, to: task.key }]));
      return doc;
    });
    broadcast(ctx, updated, 'updated');
    return toTicketDtoOne(ctx, updated);
  },

  async unlinkTask(ctx: AuthContext, id: string, taskId: string): Promise<TicketDto> {
    const { ticket, a } = await loadWithAccess(ctx, id);
    assertWritable(a);
    const task = await taskRepository.findById(ctx.workspaceId, taskId);

    const updated = await withTransaction(async (session) => {
      const doc = await ticketRepository.removeLink(ctx.workspaceId, ticket._id, oid(taskId), ctx.userId, session);
      if (!doc) throw new NotFoundError('Linked task');
      await recordActivity(session, activity(ctx, doc, 'unlinked', [{ field: 'task', from: task?.key ?? null, to: null }]));
      return doc;
    });
    broadcast(ctx, updated, 'updated');
    return toTicketDtoOne(ctx, updated);
  },

  /**
   * Creates a task from the ticket (through the tasks service, so every task rule applies) and links it.
   * The task commits in its own transaction; the link and activity follow in a second one. If that
   * second step fails the task still exists, unlinked, which is safe and visible to the user.
   */
  async convertToTask(ctx: AuthContext, id: string): Promise<ConvertTicketResultDto> {
    const { ticket, a } = await loadWithAccess(ctx, id);
    assertWritable(a);
    if (ticket.linkedTaskIds.length >= MAX_TICKET_LINKED_TASKS) throw new ConflictError(`A ticket can link at most ${MAX_TICKET_LINKED_TASKS} tasks`);

    // Keep the assignee only if they can still take work in this project.
    let assigneeId: string | null = null;
    if (ticket.assigneeId) {
      try {
        await assertAssignable(ctx, a, ticket.assigneeId);
        assigneeId = ticket.assigneeId.toHexString();
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
      }
    }

    const task = await tasksService.create(ctx, ticket.projectId.toHexString(), {
      title: ticket.title,
      description: taskDescriptionFrom(ticket),
      priority: PRIORITY_OF[ticket.severity],
      assigneeId,
      testerId: null,
      dueDate: null,
      labelIds: ticket.labelIds.map((l) => l.toHexString()),
      parentTaskId: null,
    });

    const updated = await withTransaction(async (session) => {
      const doc = await ticketRepository.addLink(ctx.workspaceId, ticket._id, oid(task.id), ctx.userId, session);
      if (!doc) throw new ConflictError(`A ticket can link at most ${MAX_TICKET_LINKED_TASKS} tasks`);
      await recordActivity(session, activity(ctx, doc, 'converted', [{ field: 'task', from: null, to: task.key }]));
      return doc;
    });
    broadcast(ctx, updated, 'updated');
    return { ticket: await toTicketDtoOne(ctx, updated), task };
  },
};
