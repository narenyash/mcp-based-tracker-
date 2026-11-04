import type { ClientSession, FilterQuery, PipelineStage, Types, UpdateQuery } from 'mongoose';
import { MAX_LINKED_TASKS, type Page, type StatusCategory } from '@teamtrack/shared';
import { Goal, type IGoal } from '../../models/Goal';
import { Task } from '../../models/Task';
import { Workspace } from '../../models/Workspace';
import { paginate } from '../../db/pagination';
import { updateVersioned } from '../../db/versioned';

/** Goals that react to task changes: closed ones keep the progress they ended with. */
const OPEN_STATUSES = ['active', 'achieved'] as const;

/** Derived fields, written without a version bump (see goals.service: system updates never conflict with edits). */
export type GoalDerived = Pick<IGoal, 'tasks' | 'progressPct' | 'status' | 'closedAt'>;

export interface SummaryBucket {
  _id: Types.ObjectId | null;
  goals: number;
  achieved: number;
  progress: number;
}

export const goalRepository = {
  findById(workspaceId: Types.ObjectId, id: Types.ObjectId | string, session?: ClientSession) {
    return Goal.findOne({ workspaceId, _id: id }).session(session ?? null).lean<IGoal>();
  },

  async create(doc: Partial<IGoal>, session: ClientSession): Promise<IGoal> {
    const [created] = await Goal.create([doc], { session });
    return created!.toObject<IGoal>();
  },

  update(workspaceId: Types.ObjectId, id: Types.ObjectId, expectedVersion: number, update: UpdateQuery<IGoal>, session?: ClientSession) {
    return updateVersioned(Goal, { workspaceId, _id: id }, expectedVersion, update, 'Goal', session);
  },

  /** Keyset-paginated, in creation order (stable while the period fills up). */
  list(filter: FilterQuery<IGoal>, limit: number, cursor?: string): Promise<Page<IGoal>> {
    return paginate(Goal, { filter, sortField: 'createdAt', direction: 1, limit, cursor });
  },

  children(workspaceId: Types.ObjectId, parentId: Types.ObjectId, limit: number) {
    return Goal.find({ workspaceId, parentGoalId: parentId }).sort({ periodStart: 1, _id: 1 }).limit(limit).lean<IGoal[]>();
  },

  /** Links a task unless already linked or the list is full. Returns null in either case. */
  pushTask(workspaceId: Types.ObjectId, id: Types.ObjectId, taskId: Types.ObjectId, actorId: Types.ObjectId, session: ClientSession) {
    return Goal.findOneAndUpdate(
      { workspaceId, _id: id, linkedTaskIds: { $ne: taskId }, [`linkedTaskIds.${MAX_LINKED_TASKS - 1}`]: { $exists: false } },
      { $push: { linkedTaskIds: taskId }, $set: { updatedBy: actorId }, $inc: { version: 1 } },
      { new: true, session, runValidators: true },
    ).lean<IGoal>();
  },

  /** Unlinks a task. Returns null if it wasn't linked. */
  pullTask(workspaceId: Types.ObjectId, id: Types.ObjectId, taskId: Types.ObjectId, actorId: Types.ObjectId, session: ClientSession) {
    return Goal.findOneAndUpdate(
      { workspaceId, _id: id, linkedTaskIds: taskId },
      { $pull: { linkedTaskIds: taskId }, $set: { updatedBy: actorId }, $inc: { version: 1 } },
      { new: true, session },
    ).lean<IGoal>();
  },

  /**
   * Writes derived fields only, and only if the status is still `expectedStatus` (so a concurrent
   * cancel or rollover wins). No version bump and no updatedAt change. Returns whether it applied.
   */
  async setDerived(workspaceId: Types.ObjectId, id: Types.ObjectId, expectedStatus: IGoal['status'], set: GoalDerived, session?: ClientSession): Promise<boolean> {
    const res = await Goal.updateOne({ workspaceId, _id: id, status: expectedStatus }, { $set: set }, { ...(session ? { session } : {}), timestamps: false });
    return res.matchedCount === 1;
  },

  /** Open goals linking a task (bounded: a task is rarely linked from more than a handful of goals). */
  openLinking(workspaceId: Types.ObjectId, taskId: Types.ObjectId, limit: number) {
    return Goal.find({ workspaceId, linkedTaskIds: taskId, status: { $in: OPEN_STATUSES } })
      .limit(limit)
      .lean<IGoal[]>();
  },

  /** Drops a deleted task from every goal that links it (derived cleanup, no version bump). */
  async pullTaskEverywhere(workspaceId: Types.ObjectId, taskId: Types.ObjectId): Promise<void> {
    await Goal.updateMany({ workspaceId, linkedTaskIds: taskId }, { $pull: { linkedTaskIds: taskId } }, { timestamps: false });
  },

  /** Marks a goal carried over, unless it already was or is no longer open. Returns null if not applied. */
  markCarried(workspaceId: Types.ObjectId, id: Types.ObjectId, carriedToId: Types.ObjectId, actorId: Types.ObjectId, session: ClientSession) {
    return Goal.findOneAndUpdate(
      { workspaceId, _id: id, status: { $in: ['active', 'missed'] }, carriedToId: null },
      { $set: { status: 'carried_over', carriedToId, closedAt: new Date(), updatedBy: actorId }, $inc: { version: 1 } },
      { new: true, session },
    ).lean<IGoal>();
  },

  async softDelete(workspaceId: Types.ObjectId, id: Types.ObjectId, actorId: Types.ObjectId, session: ClientSession): Promise<boolean> {
    const res = await Goal.updateOne({ workspaceId, _id: id }, { $set: { deletedAt: new Date(), deletedBy: actorId }, $inc: { version: 1 } }, { session });
    return res.modifiedCount === 1;
  },

  /** Children of a deleted goal stop rolling up into it. */
  async detachChildren(workspaceId: Types.ObjectId, parentId: Types.ObjectId, session: ClientSession): Promise<void> {
    await Goal.updateMany({ workspaceId, parentGoalId: parentId }, { $set: { parentGoalId: null }, $inc: { version: 1 } }, { session });
  },

  /** Per-owner and team-scope totals for a period. `peopleFilter` narrows the per-owner rows. */
  async summary(match: FilterQuery<IGoal>, peopleFilter: FilterQuery<IGoal>): Promise<{ people: SummaryBucket[]; team: SummaryBucket[] }> {
    const totals = {
      goals: { $sum: 1 },
      achieved: { $sum: { $cond: [{ $eq: ['$status', 'achieved'] }, 1, 0] } },
      progress: { $sum: '$progressPct' },
    };
    const pipeline: PipelineStage[] = [
      // Explicit deletedAt (withDeleted below) so workspaceId stays in the first $match for the tenant guard.
      { $match: { ...match, deletedAt: null } },
      {
        $facet: {
          people: [{ $match: peopleFilter }, { $group: { _id: '$ownerId', ...totals } }, { $limit: 1000 }],
          team: [{ $match: { scope: 'team' } }, { $group: { _id: null, ...totals } }],
        },
      },
    ];
    const [out] = await Goal.aggregate<{ people: SummaryBucket[]; team: SummaryBucket[] }>(pipeline).option({ withDeleted: true } as never);
    return out ?? { people: [], team: [] };
  },

  find(filter: FilterQuery<IGoal>, sort: Record<string, 1 | -1>, limit: number) {
    return Goal.find(filter).sort(sort).limit(limit).lean<IGoal[]>();
  },

  /** Active goals of one workspace whose period has ended, oldest first. */
  endedActive(workspaceId: Types.ObjectId, now: Date, limit: number) {
    return Goal.find({ workspaceId, status: 'active', periodEnd: { $lte: now } }, { _id: 1, ownerId: 1, projectId: 1, progressPct: 1 })
      .sort({ periodEnd: 1, _id: 1 })
      .limit(limit)
      .lean<Pick<IGoal, '_id' | 'ownerId' | 'projectId' | 'progressPct'>[]>();
  },

  /** Closes ended goals as achieved/missed. Re-checks status and progress, so a rerun or race is a no-op. */
  async close(workspaceId: Types.ObjectId, ids: Types.ObjectId[], status: 'achieved' | 'missed', now: Date): Promise<number> {
    if (!ids.length) return 0;
    const progressPct = status === 'achieved' ? { $gte: 100 } : { $lt: 100 };
    const res = await Goal.updateMany(
      { workspaceId, _id: { $in: ids }, status: 'active', periodEnd: { $lte: now }, progressPct },
      { $set: { status, closedAt: now } },
      { timestamps: false },
    );
    return res.modifiedCount;
  },
};

export type LinkedTask = { _id: Types.ObjectId; key: string; title: string; projectId: Types.ObjectId; statusCategory: StatusCategory };

/** Read-only view of tasks for linking and progress. */
export const goalTaskRepository = {
  findByIds(workspaceId: Types.ObjectId, ids: Types.ObjectId[], session?: ClientSession) {
    if (!ids.length) return Promise.resolve([] as LinkedTask[]);
    return Task.find({ workspaceId, _id: { $in: ids } }, { _id: 1, key: 1, title: 1, projectId: 1, statusCategory: 1 })
      .session(session ?? null)
      .lean<LinkedTask[]>();
  },

  /** Live (not deleted) linked tasks and how many are done. */
  async counts(workspaceId: Types.ObjectId, ids: Types.ObjectId[], session?: ClientSession): Promise<{ total: number; done: number }> {
    if (!ids.length) return { total: 0, done: 0 };
    const tasks = await Task.find({ workspaceId, _id: { $in: ids } }, { statusCategory: 1 })
      .session(session ?? null)
      .lean<{ statusCategory: StatusCategory }[]>();
    return { total: tasks.length, done: tasks.filter((t) => t.statusCategory === 'done').length };
  },
};

export const goalWorkspaceRepository = {
  /** Every workspace id, for system jobs that run per tenant. */
  async ids(): Promise<Types.ObjectId[]> {
    const docs = await Workspace.find({}, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>();
    return docs.map((d) => d._id);
  },
};
