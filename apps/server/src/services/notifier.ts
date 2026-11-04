import { Types } from 'mongoose';
import type { EntityType, NotificationType } from '@teamtrack/shared';
import { env } from '../config/env';
import type { IUser } from '../models/User';
import { notificationRepository } from '../repositories/notificationRepository';
import { userRepository } from '../repositories/userRepository';
import { toNotificationDto } from '../modules/dto';
import { logger } from '../observability/logger';
import type { EmailJob } from './mailer';
import { enqueue, type OutboxMessage } from './outbox';
import { realtime } from './realtime';

/** Everything needed to render one notification, captured when the business change commits. */
export interface NotifyJob {
  workspaceId: string;
  userId: string;
  type: NotificationType;
  actor: { id: string; name: string } | null;
  projectId: string | null;
  /** Shown in emails under the subject line; for project-less things (personal goals) use the workspace name. */
  projectName: string;
  /** The thing the notification is about. */
  subject: { type: EntityType; id: string; key: string; title: string };
  /** In-app path. Defaults to the task drawer for tasks; required for every other subject type. */
  path?: string;
  /** Handover note, failure note, or comment excerpt. */
  note: string;
  /** Test round (test_requested) or a human date like "tomorrow" / "Nov 3" (due reminders). */
  round?: number;
  when?: string;
}

type EmailPref = keyof IUser['notificationPrefs']['email'];

const EMAIL_PREF: Record<NotificationType, EmailPref> = {
  task_assigned: 'assigned',
  test_requested: 'testing',
  test_failed: 'testing',
  test_passed: 'testing',
  task_due_soon: 'dueSoon',
  task_overdue: 'dueSoon',
  ticket_assigned: 'assigned',
  ticket_resolved: 'assigned',
  mentioned: 'mentioned',
  comment_added: 'mentioned',
};

export const taskPath = (projectId: string, taskId: string) => `/projects/${projectId}?task=${taskId}`;

function pathOf(job: NotifyJob): string {
  if (job.path) return job.path;
  if (job.subject.type === 'task' && job.projectId) return taskPath(job.projectId, job.subject.id);
  throw new Error(`NotifyJob for a ${job.subject.type} needs an explicit path`);
}

/** Outbox message for one notification. Delivery (in-app + email) happens after the transaction commits. */
export function notifyMessage(job: NotifyJob, dedupeKey: string): OutboxMessage<'notify'> {
  pathOf(job); // fail at enqueue time, inside the caller's transaction, not later in the worker
  return { type: 'notify', dedupeKey, payload: job };
}

function headline(job: NotifyJob): string {
  const who = job.actor?.name ?? 'Someone';
  const key = job.subject.key;
  switch (job.type) {
    case 'task_assigned':
    case 'ticket_assigned':
      return `${who} assigned you ${key}`;
    case 'test_requested':
      return `${who} asked you to test ${key}`;
    case 'test_failed':
      return `${key} failed testing`;
    case 'test_passed':
      return `${key} passed testing`;
    case 'task_due_soon':
      return `${key} is due ${job.when ?? 'soon'}`;
    case 'task_overdue':
      return `${key} is overdue`;
    case 'ticket_resolved':
      return `${who} resolved ${key}`;
    case 'mentioned':
      return `${who} mentioned you on ${key}`;
    case 'comment_added':
      return `${who} commented on ${key}`;
  }
}

function emailFor(job: NotifyJob, to: string): EmailJob {
  const base = { taskKey: job.subject.key, taskTitle: job.subject.title, projectName: job.projectName, url: env.CLIENT_URL + pathOf(job) };
  const actorName = job.actor?.name ?? 'Someone';
  const common = { to, workspaceId: job.workspaceId };
  switch (job.type) {
    case 'task_assigned':
    case 'ticket_assigned':
      return { ...common, template: 'taskAssigned', data: { actorName, ...base } };
    case 'test_requested':
      return { ...common, template: 'testRequested', data: { actorName, ...base, round: job.round ?? 1, note: job.note } };
    case 'test_failed':
      return { ...common, template: 'testFailed', data: { testerName: actorName, ...base, note: job.note } };
    case 'test_passed':
      return { ...common, template: 'testPassed', data: { testerName: actorName, ...base } };
    case 'task_due_soon':
    case 'task_overdue':
      return { ...common, template: 'taskDue', data: { ...base, when: job.when ?? 'soon', overdue: job.type === 'task_overdue' } };
    case 'ticket_resolved':
      return { ...common, template: 'ticketResolved', data: { actorName, ...base, note: job.note } };
    case 'mentioned':
    case 'comment_added':
      return { ...common, template: 'commented', data: { actorName, ...base, note: job.note, mentioned: job.type === 'mentioned' } };
  }
}

/**
 * Outbox handler: stores the in-app notification, pushes it to the user's open tabs, and queues the
 * email if their preferences allow. Every step is idempotent on the dedupe key, so retries are safe.
 */
export async function deliverNotification(job: NotifyJob, dedupeKey: string): Promise<void> {
  const workspaceId = new Types.ObjectId(job.workspaceId);
  const user = await userRepository.findById(workspaceId, job.userId);
  if (!user || user.status !== 'active') {
    logger.debug({ userId: job.userId, type: job.type }, 'notification skipped: recipient inactive');
    return;
  }

  const { doc, created } = await notificationRepository.insertOnce({
    workspaceId,
    userId: user._id,
    type: job.type,
    actor: job.actor ? { id: new Types.ObjectId(job.actor.id), name: job.actor.name } : null,
    projectId: job.projectId ? new Types.ObjectId(job.projectId) : null,
    entityType: job.subject.type,
    entityId: new Types.ObjectId(job.subject.id),
    entityKey: job.subject.key,
    title: headline(job).slice(0, 300),
    body: job.subject.title.slice(0, 300),
    note: job.note.slice(0, 2000),
    path: pathOf(job),
    sourceKey: dedupeKey,
  });
  if (created) realtime.toUser(user._id.toHexString(), 'notification:new', toNotificationDto(doc));

  // A missing preference (older user documents) means the default: on.
  if (user.notificationPrefs?.email?.[EMAIL_PREF[job.type]] !== false) {
    await enqueue(null, [{ type: 'email.send', dedupeKey: `${dedupeKey}:email`, payload: emailFor(job, user.email) }]);
  }
}
