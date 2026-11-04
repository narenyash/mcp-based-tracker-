import type { ClientSession, FilterQuery, Types, UpdateQuery } from 'mongoose';
import type { Page } from '@teamtrack/shared';
import { Task, MAX_CHECKLIST_ITEMS, type ITask } from '../models/Task';
import { Counter } from '../models/Counter';
import { Label, type ILabel } from '../models/Label';
import { paginate } from '../db/pagination';
import { updateVersioned } from '../db/versioned';

/** Fields needed to place a task in a column; avoids loading descriptions and checklists. */
export type RankedTask = Pick<ITask, '_id' | 'rank' | 'statusId' | 'projectId' | 'parentTaskId'>;
const RANK_FIELDS = { _id: 1, rank: 1, statusId: 1, projectId: 1, parentTaskId: 1 } as const;

interface Column {
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId;
  parentTaskId: Types.ObjectId | null;
  statusId: string;
}

export const taskRepository = {
  findById(workspaceId: Types.ObjectId, id: Types.ObjectId | string, session?: ClientSession) {
    return Task.findOne({ workspaceId, _id: id }).session(session ?? null).lean<ITask>();
  },

  findRanked(workspaceId: Types.ObjectId, ids: Types.ObjectId[], session?: ClientSession) {
    return Task.find({ workspaceId, _id: { $in: ids } }, RANK_FIELDS).session(session ?? null).lean<RankedTask[]>();
  },

  /** Nearest task in a column above (`dir = -1`) or below (`dir = 1`) a rank, or the column end when rank is null. */
  neighbour(col: Column, rank: string | null, dir: 1 | -1, exclude: Types.ObjectId | null, session?: ClientSession) {
    const filter: FilterQuery<ITask> = { ...col };
    if (rank !== null) filter.rank = dir === 1 ? { $gt: rank } : { $lt: rank };
    if (exclude) filter._id = { $ne: exclude };
    return Task.findOne(filter, RANK_FIELDS).sort({ rank: dir, _id: dir }).session(session ?? null).lean<RankedTask>();
  },

  /** Ids of a column in order, for re-spacing. */
  async columnIds(col: Column, exclude: Types.ObjectId | null, session: ClientSession): Promise<Types.ObjectId[]> {
    const filter: FilterQuery<ITask> = { ...col };
    if (exclude) filter._id = { $ne: exclude };
    const docs = await Task.find(filter, { _id: 1 }).sort({ rank: 1, _id: 1 }).session(session).lean<{ _id: Types.ObjectId }[]>();
    return docs.map((d) => d._id);
  },

  /**
   * Rewrites ranks only. No version bump and no updatedAt change: a rank is placement, not content,
   * and clients position cards by neighbour ids, so their cached versions stay valid.
   */
  async setRanks(workspaceId: Types.ObjectId, ranks: { id: Types.ObjectId; rank: string }[], session: ClientSession): Promise<void> {
    if (!ranks.length) return;
    await Task.bulkWrite(
      ranks.map((r) => ({ updateOne: { filter: { workspaceId, _id: r.id }, update: { $set: { rank: r.rank } } } })),
      { session, ordered: false, timestamps: false },
    );
  },

  async create(doc: Partial<ITask>, session: ClientSession): Promise<ITask> {
    const [created] = await Task.create([doc], { session });
    return created!.toObject<ITask>();
  },

  update(workspaceId: Types.ObjectId, id: Types.ObjectId, expectedVersion: number, update: UpdateQuery<ITask>, session?: ClientSession) {
    return updateVersioned(Task, { workspaceId, _id: id }, expectedVersion, update, 'Task', session);
  },

  /** Top-level tasks of a project in board order. Fetches `limit + 1` so the caller can detect truncation. */
  board(workspaceId: Types.ObjectId, projectId: Types.ObjectId, limit: number) {
    return Task.find({ workspaceId, projectId, parentTaskId: null }).sort({ rank: 1, _id: 1 }).limit(limit + 1).lean<ITask[]>();
  },

  list(filter: FilterQuery<ITask>, sort: { field: string; direction: 1 | -1 }, limit: number, cursor?: string): Promise<Page<ITask>> {
    return paginate(Task, { filter, sortField: sort.field, direction: sort.direction, limit, cursor });
  },

  async adjustSubtaskCounts(workspaceId: Types.ObjectId, parentId: Types.ObjectId, inc: { subtasks?: number; subtasksDone?: number }, session: ClientSession): Promise<void> {
    const $inc: Record<string, number> = {};
    if (inc.subtasks) $inc['counts.subtasks'] = inc.subtasks;
    if (inc.subtasksDone) $inc['counts.subtasksDone'] = inc.subtasksDone;
    if (Object.keys($inc).length) await Task.updateOne({ workspaceId, _id: parentId }, { $inc }, { session });
  },

  subtaskIds(workspaceId: Types.ObjectId, parentId: Types.ObjectId, session: ClientSession) {
    return Task.find({ workspaceId, parentTaskId: parentId }, { _id: 1 }).session(session).lean<{ _id: Types.ObjectId }[]>();
  },

  async softDelete(workspaceId: Types.ObjectId, ids: Types.ObjectId[], actorId: Types.ObjectId, session: ClientSession): Promise<number> {
    const res = await Task.updateMany(
      { workspaceId, _id: { $in: ids } },
      { $set: { deletedAt: new Date(), deletedBy: actorId }, $inc: { version: 1 } },
      { session },
    );
    return res.modifiedCount;
  },

  async softDeleteByProject(workspaceId: Types.ObjectId, projectId: Types.ObjectId, actorId: Types.ObjectId, session: ClientSession): Promise<void> {
    await Task.updateMany({ workspaceId, projectId }, { $set: { deletedAt: new Date(), deletedBy: actorId }, $inc: { version: 1 } }, { session });
  },

  async pullLabel(workspaceId: Types.ObjectId, labelId: Types.ObjectId, session: ClientSession): Promise<void> {
    await Task.updateMany({ workspaceId, labelIds: labelId }, { $pull: { labelIds: labelId }, $inc: { version: 1 } }, { session });
  },

  /** Appends a checklist item unless the list is full. Returns null if the task is gone or full. */
  pushChecklistItem(workspaceId: Types.ObjectId, id: Types.ObjectId, item: { text: string }, actorId: Types.ObjectId) {
    return Task.findOneAndUpdate(
      { workspaceId, _id: id, [`checklist.${MAX_CHECKLIST_ITEMS - 1}`]: { $exists: false } },
      { $push: { checklist: { text: item.text, done: false } }, $set: { updatedBy: actorId }, $inc: { version: 1 } },
      { new: true, runValidators: true },
    ).lean<ITask>();
  },

  setChecklistItem(workspaceId: Types.ObjectId, id: Types.ObjectId, itemId: Types.ObjectId, set: { text?: string; done?: boolean }, actorId: Types.ObjectId) {
    const $set: Record<string, unknown> = { updatedBy: actorId };
    if (set.text !== undefined) $set['checklist.$[item].text'] = set.text;
    if (set.done !== undefined) {
      $set['checklist.$[item].done'] = set.done;
      $set['checklist.$[item].doneBy'] = set.done ? actorId : null;
      $set['checklist.$[item].doneAt'] = set.done ? new Date() : null;
    }
    return Task.findOneAndUpdate(
      { workspaceId, _id: id, 'checklist._id': itemId },
      { $set, $inc: { version: 1 } },
      { new: true, arrayFilters: [{ 'item._id': itemId }], runValidators: true },
    ).lean<ITask>();
  },

  pullChecklistItem(workspaceId: Types.ObjectId, id: Types.ObjectId, itemId: Types.ObjectId, actorId: Types.ObjectId) {
    return Task.findOneAndUpdate(
      { workspaceId, _id: id, 'checklist._id': itemId },
      { $pull: { checklist: { _id: itemId } }, $set: { updatedBy: actorId }, $inc: { version: 1 } },
      { new: true },
    ).lean<ITask>();
  },
};

export const counterRepository = {
  /** Atomically allocates the next number in a per-project sequence. Must run inside the creating transaction. */
  async next(workspaceId: Types.ObjectId, projectId: Types.ObjectId, kind: 'task' | 'ticket', session: ClientSession): Promise<number> {
    const doc = await Counter.findOneAndUpdate(
      { _id: `${projectId.toHexString()}:${kind}` },
      { $inc: { seq: 1, version: 1 }, $setOnInsert: { workspaceId } },
      { upsert: true, new: true, session },
    ).lean();
    return doc!.seq;
  },
};

export const labelRepository = {
  listForProject(workspaceId: Types.ObjectId, projectId: Types.ObjectId) {
    return Label.find({ workspaceId, projectId }).collation({ locale: 'en', strength: 2 }).sort({ name: 1 }).limit(200).lean<ILabel[]>();
  },

  async countInProject(workspaceId: Types.ObjectId, projectId: Types.ObjectId, ids: Types.ObjectId[]): Promise<number> {
    return Label.countDocuments({ workspaceId, projectId, _id: { $in: ids } });
  },

  async create(doc: Pick<ILabel, 'workspaceId' | 'projectId' | 'name' | 'color'> & { createdBy: Types.ObjectId }): Promise<ILabel> {
    return (await Label.create(doc)).toObject<ILabel>();
  },

  async remove(workspaceId: Types.ObjectId, projectId: Types.ObjectId, id: Types.ObjectId, session: ClientSession): Promise<boolean> {
    const res = await Label.deleteOne({ workspaceId, projectId, _id: id }, { session });
    return res.deletedCount === 1;
  },
};
