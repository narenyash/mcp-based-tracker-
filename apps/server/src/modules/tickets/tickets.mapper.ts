import type { Types } from 'mongoose';
import type { PersonRef, TicketDto } from '@teamtrack/shared';
import type { AuthContext } from '../../auth/context';
import type { IUser } from '../../models/User';
import type { ITicket } from '../../models/Ticket';
import { userRepository } from '../../repositories/userRepository';
import { ticketRepository, type TaskSummary } from './ticketRepository';

/** Explicit DTO mapping for tickets: the API never serialises raw documents. */

export type Users = Map<string, Pick<IUser, '_id' | 'name'>>;

export const ticketPath = (ticketId: string) => `/tickets?ticket=${ticketId}`;

export async function loadUsers(ctx: AuthContext, ids: (Types.ObjectId | null | undefined)[]): Promise<Users> {
  const unique = new Map<string, Types.ObjectId>();
  for (const id of ids) if (id) unique.set(id.toHexString(), id);
  if (!unique.size) return new Map();
  const users = await userRepository.findByIds(ctx.workspaceId, [...unique.values()]);
  return new Map(users.map((u) => [u._id.toHexString(), u]));
}

export function personRef(people: Users, id: Types.ObjectId | null | undefined): PersonRef | null {
  if (!id) return null;
  const u = people.get(id.toHexString());
  return u ? { id: u._id.toHexString(), name: u.name } : { id: id.toHexString(), name: 'Removed user' };
}

interface Related {
  people: Users;
  tasks: Map<string, TaskSummary>;
  duplicates: Map<string, string>;
}

function toTicketDto(t: ITicket, r: Related): TicketDto {
  const env = t.environment ?? { browser: '', os: '', url: '', version: '' };
  return {
    id: t._id.toHexString(),
    key: t.key,
    number: t.number,
    projectId: t.projectId.toHexString(),
    title: t.title,
    description: t.description,
    type: t.type,
    severity: t.severity,
    statusId: t.statusId,
    statusCategory: t.statusCategory,
    assignee: personRef(r.people, t.assigneeId),
    reporter: personRef(r.people, t.reporterId),
    environment: { browser: env.browser ?? '', os: env.os ?? '', url: env.url ?? '', version: env.version ?? '' },
    stepsToReproduce: t.stepsToReproduce,
    expected: t.expected,
    actual: t.actual,
    resolution: t.resolution,
    duplicateOf: t.duplicateOfId
      ? { id: t.duplicateOfId.toHexString(), key: r.duplicates.get(t.duplicateOfId.toHexString()) ?? 'Deleted ticket' }
      : null,
    resolvedAt: t.resolvedAt?.toISOString() ?? null,
    resolvedBy: personRef(r.people, t.resolvedBy),
    reopenCount: t.reopenCount,
    labelIds: t.labelIds.map((l) => l.toHexString()),
    linkedTasks: t.linkedTaskIds.flatMap((id) => {
      const task = r.tasks.get(id.toHexString());
      return task
        ? [{ id: task._id.toHexString(), key: task.key, title: task.title, projectId: task.projectId.toHexString(), statusId: task.statusId, statusCategory: task.statusCategory }]
        : [];
    }),
    rank: t.rank,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    version: t.version,
  };
}

/** Maps a page of tickets with one batched lookup each for people, linked tasks and duplicate keys. */
export async function toTicketDtos(ctx: AuthContext, tickets: ITicket[]): Promise<TicketDto[]> {
  const [people, tasks, duplicates] = await Promise.all([
    loadUsers(ctx, tickets.flatMap((t) => [t.assigneeId, t.reporterId, t.resolvedBy])),
    ticketRepository.taskSummaries(ctx.workspaceId, tickets.flatMap((t) => t.linkedTaskIds)),
    ticketRepository.findKeys(ctx.workspaceId, tickets.flatMap((t) => (t.duplicateOfId ? [t.duplicateOfId] : []))),
  ]);
  const related: Related = {
    people,
    tasks: new Map(tasks.map((t) => [t._id.toHexString(), t])),
    duplicates: new Map(duplicates.map((d) => [d._id.toHexString(), d.key])),
  };
  return tickets.map((t) => toTicketDto(t, related));
}

export const toTicketDtoOne = async (ctx: AuthContext, t: ITicket) => (await toTicketDtos(ctx, [t]))[0]!;
