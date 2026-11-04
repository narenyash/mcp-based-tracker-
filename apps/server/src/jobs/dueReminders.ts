import type { Types } from 'mongoose';
import { withTransaction } from '../db/transaction';
import { Project, Task, Workspace } from '../models';
import type { ITask } from '../models/Task';
import { notifyMessage } from '../services/notifier';
import { enqueue } from '../services/outbox';
import { logger } from '../observability/logger';
import type { Job } from './scheduler';

const DAY_MS = 24 * 3600_000;
/** Reminders go out during the workspace's working hours only, never at 3 am. */
const SEND_FROM_HOUR = 9;
const SEND_UNTIL_HOUR = 20;
const BATCH = 500;

type DueTask = Pick<ITask, '_id' | 'projectId' | 'key' | 'title' | 'assigneeId' | 'dueDate' | 'reminders'>;

/** Calendar date and hour "now" in a timezone. Due dates are stored as that calendar day at 00:00 UTC. */
export function localClock(timeZone: string, now: Date): { today: Date; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { today: new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`), hour: Number(parts.hour) };
}

const shortDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Sends each assignee one "due soon" notice (due today or tomorrow) and one "overdue" notice per due
 * date. The task is marked in the same transaction as the outbox write, so a reminder is never sent
 * twice or lost; changing the due date re-arms both.
 */
export async function sendDueReminders(now = new Date()): Promise<number> {
  let sent = 0;
  const workspaces = await Workspace.find({}, { _id: 1, timezone: 1 }).lean<{ _id: Types.ObjectId; timezone: string }[]>();
  for (const ws of workspaces) {
    const { today, hour } = localClock(ws.timezone, now);
    if (hour < SEND_FROM_HOUR || hour >= SEND_UNTIL_HOUR) continue;
    const tomorrow = new Date(today.getTime() + DAY_MS);

    const tasks = await Task.find(
      { workspaceId: ws._id, assigneeId: { $type: 'objectId' }, dueDate: { $type: 'date', $lte: tomorrow }, statusCategory: { $ne: 'done' } },
      { _id: 1, projectId: 1, key: 1, title: 1, assigneeId: 1, dueDate: 1, reminders: 1 },
    )
      .sort({ dueDate: 1 })
      .limit(BATCH)
      .lean<DueTask[]>();
    const due = tasks.filter((t) => {
      const overdue = t.dueDate! < today;
      const last = overdue ? t.reminders?.overdueFor : t.reminders?.dueSoonFor;
      return last?.getTime() !== t.dueDate!.getTime();
    });
    if (!due.length) continue;

    const projects = await Project.find({ workspaceId: ws._id, _id: { $in: [...new Set(due.map((t) => t.projectId.toHexString()))] } }, { name: 1 }).lean<
      { _id: Types.ObjectId; name: string }[]
    >();
    const projectName = new Map(projects.map((p) => [p._id.toHexString(), p.name]));

    for (const t of due) {
      const dueDate = t.dueDate!;
      const overdue = dueDate < today;
      const field = overdue ? 'reminders.overdueFor' : 'reminders.dueSoonFor';
      const when = overdue ? shortDate(dueDate) : dueDate.getTime() === today.getTime() ? 'today' : 'tomorrow';
      const name = projectName.get(t.projectId.toHexString());
      if (!name) continue;
      const claimed = await withTransaction(async (session) => {
        // Re-checks assignee and due date so an edit since the read above isn't reminded about.
        const res = await Task.updateOne(
          { workspaceId: ws._id, _id: t._id, assigneeId: t.assigneeId, dueDate, statusCategory: { $ne: 'done' }, [field]: { $ne: dueDate } },
          { $set: { [field]: dueDate } },
          { session, timestamps: false },
        );
        if (res.modifiedCount !== 1) return false;
        const job = {
          workspaceId: ws._id.toHexString(),
          userId: t.assigneeId!.toHexString(),
          type: overdue ? ('task_overdue' as const) : ('task_due_soon' as const),
          actor: null,
          projectId: t.projectId.toHexString(),
          projectName: name,
          subject: { type: 'task' as const, id: t._id.toHexString(), key: t.key, title: t.title },
          note: '',
          when,
        };
        await enqueue(session, [notifyMessage(job, `task:${t._id.toHexString()}:${overdue ? 'overdue' : 'due'}:${ymd(dueDate)}:${job.userId}`)]);
        return true;
      });
      if (claimed) sent++;
    }
  }
  if (sent) logger.info({ sent }, 'due-date reminders queued');
  return sent;
}

export const dueReminders: Job = {
  name: 'due-reminders',
  everyMs: 15 * 60_000,
  leaseMs: 10 * 60_000,
  run: async () => {
    await sendDueReminders();
  },
};
