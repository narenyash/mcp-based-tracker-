import type { ClientSession, FilterQuery, Types, UpdateQuery } from 'mongoose';
import { MAX_TICKET_LINKED_TASKS, type Page } from '@teamtrack/shared';
import { Ticket, type ITicket } from '../../models/Ticket';
import { Counter } from '../../models/Counter';
import { Task, type ITask } from '../../models/Task';
import { paginate } from '../../db/pagination';
import { updateVersioned } from '../../db/versioned';

/** Fields needed to place a ticket in a column; avoids loading long text. */
export type RankedTicket = Pick<ITicket, '_id' | 'rank' | 'statusId' | 'projectId'>;
const RANK_FIELDS = { _id: 1, rank: 1, statusId: 1, projectId: 1 } as const;

export type TaskSummary = Pick<ITask, '_id' | 'key' | 'title' | 'projectId' | 'statusId' | 'statusCategory'>;
const TASK_SUMMARY_FIELDS = { _id: 1, key: 1, title: 1, projectId: 1, statusId: 1, statusCategory: 1 } as const;

export interface TicketColumn {
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId;
  statusId: string;
}

export const ticketRepository = {
  findById(workspaceId: Types.ObjectId, id: Types.ObjectId | string, session?: ClientSession) {
    return Ticket.findOne({ workspaceId, _id: id }).session(session ?? null).lean<ITicket>();
  },

  findKeys(workspaceId: Types.ObjectId, ids: Types.ObjectId[]) {
    if (!ids.length) return Promise.resolve([]);
    return Ticket.find({ workspaceId, _id: { $in: ids } }, { _id: 1, key: 1, projectId: 1 }).lean<Pick<ITicket, '_id' | 'key' | 'projectId'>[]>();
  },

  findRanked(workspaceId: Types.ObjectId, ids: Types.ObjectId[], session?: ClientSession) {
    return Ticket.find({ workspaceId, _id: { $in: ids } }, RANK_FIELDS).session(session ?? null).lean<RankedTicket[]>();
  },

  /** Nearest ticket in a column above (`dir = -1`) or below (`dir = 1`) a rank, or the column end when rank is null. */
  neighbour(col: TicketColumn, rank: string | null, dir: 1 | -1, exclude: Types.ObjectId | null, session?: ClientSession) {
    const filter: FilterQuery<ITicket> = { ...col };
    if (rank !== null) filter.rank = dir === 1 ? { $gt: rank } : { $lt: rank };
    if (exclude) filter._id = { $ne: exclude };
    return Ticket.findOne(filter, RANK_FIELDS).sort({ rank: dir, _id: dir }).session(session ?? null).lean<RankedTicket>();
  },

  /** Ids of a column in order, for re-spacing. */
  async columnIds(col: TicketColumn, exclude: Types.ObjectId | null, session: ClientSession): Promise<Types.ObjectId[]> {
    const filter: FilterQuery<ITicket> = { ...col };
    if (exclude) filter._id = { $ne: exclude };
    const docs = await Ticket.find(filter, { _id: 1 }).sort({ rank: 1, _id: 1 }).session(session).lean<{ _id: Types.ObjectId }[]>();
    return docs.map((d) => d._id);
  },

  /** Rewrites ranks only (no version bump): placement is not content. See taskRepository.setRanks. */
  async setRanks(workspaceId: Types.ObjectId, ranks: { id: Types.ObjectId; rank: string }[], session: ClientSession): Promise<void> {
    if (!ranks.length) return;
    await Ticket.bulkWrite(
      ranks.map((r) => ({ updateOne: { filter: { workspaceId, _id: r.id }, update: { $set: { rank: r.rank } } } })),
      { session, ordered: false, timestamps: false },
    );
  },

  async create(doc: Partial<ITicket>, session: ClientSession): Promise<ITicket> {
    const [created] = await Ticket.create([doc], { session });
    return created!.toObject<ITicket>();
  },

  update(workspaceId: Types.ObjectId, id: Types.ObjectId, expectedVersion: number, update: UpdateQuery<ITicket>, session?: ClientSession) {
    return updateVersioned(Ticket, { workspaceId, _id: id }, expectedVersion, update, 'Ticket', session);
  },

  /** Tickets of a project in board order. Fetches `limit + 1` so the caller can detect truncation. */
  board(workspaceId: Types.ObjectId, projectId: Types.ObjectId, limit: number) {
    return Ticket.find({ workspaceId, projectId }).sort({ rank: 1, _id: 1 }).limit(limit + 1).lean<ITicket[]>();
  },

  list(filter: FilterQuery<ITicket>, sort: { field: string; direction: 1 | -1 }, limit: number, cursor?: string): Promise<Page<ITicket>> {
    return paginate(Ticket, { filter, sortField: sort.field, direction: sort.direction, limit, cursor });
  },

  search(filter: FilterQuery<ITicket>, limit: number) {
    return Ticket.find(filter, { _id: 1, key: 1, title: 1, projectId: 1, statusId: 1 })
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit)
      .lean<Pick<ITicket, '_id' | 'key' | 'title' | 'projectId' | 'statusId'>[]>();
  },

  /**
   * Adds a task link unless the list is full. Not version-checked (like checklist edits): a link is
   * additive and idempotent. Returns null if the ticket is gone or full.
   */
  addLink(workspaceId: Types.ObjectId, id: Types.ObjectId, taskId: Types.ObjectId, actorId: Types.ObjectId, session: ClientSession) {
    return Ticket.findOneAndUpdate(
      { workspaceId, _id: id, [`linkedTaskIds.${MAX_TICKET_LINKED_TASKS - 1}`]: { $exists: false } },
      { $addToSet: { linkedTaskIds: taskId }, $set: { updatedBy: actorId }, $inc: { version: 1 } },
      { new: true, runValidators: true, session },
    ).lean<ITicket>();
  },

  removeLink(workspaceId: Types.ObjectId, id: Types.ObjectId, taskId: Types.ObjectId, actorId: Types.ObjectId, session: ClientSession) {
    return Ticket.findOneAndUpdate(
      { workspaceId, _id: id, linkedTaskIds: taskId },
      { $pull: { linkedTaskIds: taskId }, $set: { updatedBy: actorId }, $inc: { version: 1 } },
      { new: true, session },
    ).lean<ITicket>();
  },

  async softDelete(workspaceId: Types.ObjectId, id: Types.ObjectId, actorId: Types.ObjectId, session: ClientSession): Promise<boolean> {
    const res = await Ticket.updateOne(
      { workspaceId, _id: id },
      { $set: { deletedAt: new Date(), deletedBy: actorId }, $inc: { version: 1 } },
      { session },
    );
    return res.modifiedCount === 1;
  },

  /** Live (not deleted) tasks among `ids`, for showing links. Read-only view of the tasks collection. */
  taskSummaries(workspaceId: Types.ObjectId, ids: Types.ObjectId[]) {
    if (!ids.length) return Promise.resolve([] as TaskSummary[]);
    return Task.find({ workspaceId, _id: { $in: ids } }, TASK_SUMMARY_FIELDS).lean<TaskSummary[]>();
  },
};

export const ticketCounterRepository = {
  /**
   * Allocates the next workspace-wide ticket number ("<workspaceId>:ticket"). Must run inside the
   * creating transaction, so an aborted create also rolls back its number.
   */
  async next(workspaceId: Types.ObjectId, session: ClientSession): Promise<number> {
    const doc = await Counter.findOneAndUpdate(
      { _id: `${workspaceId.toHexString()}:ticket` },
      { $inc: { seq: 1, version: 1 }, $setOnInsert: { workspaceId } },
      { upsert: true, new: true, session },
    ).lean();
    return doc!.seq;
  },
};
