import type { InviteDto, LabelDto, NotificationDto, NotificationPrefsDto, PersonRef, ProjectDto, ProjectRole, TaskDto, UserDto, WorkspaceDto } from '@teamtrack/shared';
import type { Types } from 'mongoose';
import type { IUser } from '../models/User';
import type { IWorkspace } from '../models/Workspace';
import type { IInvite } from '../models/Invite';
import type { IProject } from '../models/Project';
import type { ITask } from '../models/Task';
import type { ILabel } from '../models/Label';
import type { INotification } from '../models/Notification';

/** Explicit DTO mappers: the API never serialises raw documents, so internal fields cannot leak. */

export function toUserDto(u: IUser): UserDto {
  return {
    id: u._id.toHexString(),
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    avatarUrl: null,
    lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    version: u.version,
  };
}

export function toWorkspaceDto(w: IWorkspace): WorkspaceDto {
  return { id: w._id.toHexString(), name: w.name, slug: w.slug, timezone: w.timezone };
}

export function toInviteDto(i: IInvite): InviteDto {
  return {
    id: i._id.toHexString(),
    email: i.email,
    role: i.role,
    invitedBy: i.invitedBy.toHexString(),
    expiresAt: i.expiresAt.toISOString(),
    createdAt: i.createdAt.toISOString(),
  };
}

export function toProjectDto(p: IProject, myRole: ProjectRole | null): ProjectDto {
  return {
    id: p._id.toHexString(),
    key: p.key,
    name: p.name,
    description: p.description,
    color: p.color,
    visibility: p.visibility,
    status: p.status,
    leadId: p.leadId.toHexString(),
    memberCount: p.memberCount,
    workflow: {
      taskStatuses: p.workflow.taskStatuses.map((s) => ({ ...s })),
      ticketStatuses: p.workflow.ticketStatuses.map((s) => ({ ...s })),
    },
    myRole,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    version: p.version,
  };
}

/** Users referenced by a set of tasks, keyed by hex id. Resolved per request, so names are never stale. */
export type People = Map<string, Pick<IUser, '_id' | 'name'>>;

function ref(people: People, id: Types.ObjectId | null | undefined): PersonRef | null {
  if (!id) return null;
  const u = people.get(id.toHexString());
  return u ? { id: u._id.toHexString(), name: u.name } : { id: id.toHexString(), name: 'Removed user' };
}

const isoDate = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

export function toTaskDto(t: ITask, people: People): TaskDto {
  return {
    id: t._id.toHexString(),
    key: t.key,
    number: t.number,
    projectId: t.projectId.toHexString(),
    parentTaskId: t.parentTaskId?.toHexString() ?? null,
    title: t.title,
    description: t.description,
    statusId: t.statusId,
    statusCategory: t.statusCategory,
    priority: t.priority,
    assignee: ref(people, t.assigneeId),
    tester: ref(people, t.testerId),
    reporter: ref(people, t.reporterId),
    labelIds: t.labelIds.map((l) => l.toHexString()),
    dueDate: isoDate(t.dueDate),
    completedAt: t.completedAt?.toISOString() ?? null,
    rank: t.rank,
    checklist: t.checklist.map((c) => ({ id: c._id.toHexString(), text: c.text, done: c.done })),
    counts: {
      subtasks: t.counts.subtasks,
      subtasksDone: t.counts.subtasksDone,
      checklist: t.checklist.length,
      checklistDone: t.checklist.filter((c) => c.done).length,
    },
    testing: t.testing
      ? {
          round: t.testing.round,
          result: t.testing.result,
          sentAt: t.testing.sentAt.toISOString(),
          sentBy: ref(people, t.testing.sentBy),
          resultAt: t.testing.resultAt?.toISOString() ?? null,
          resultBy: ref(people, t.testing.resultBy),
          note: t.testing.note,
        }
      : null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    version: t.version,
  };
}

export function toLabelDto(l: ILabel): LabelDto {
  return { id: l._id.toHexString(), name: l.name, color: l.color };
}

export function toNotificationDto(n: INotification): NotificationDto {
  return {
    id: n._id.toHexString(),
    type: n.type,
    title: n.title,
    body: n.body,
    note: n.note,
    path: n.path,
    actor: n.actor ? { id: n.actor.id.toHexString(), name: n.actor.name } : null,
    entityType: n.entityType,
    entityKey: n.entityKey,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  };
}

export function toNotificationPrefsDto(u: IUser): NotificationPrefsDto {
  const e = u.notificationPrefs?.email;
  return { email: { assigned: e?.assigned !== false, testing: e?.testing !== false, dueSoon: e?.dueSoon !== false, mentioned: e?.mentioned !== false } };
}
