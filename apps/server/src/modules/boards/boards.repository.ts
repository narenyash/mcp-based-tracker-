import type { ClientSession, FilterQuery, Types } from 'mongoose';
import { WHITEBOARD_LIMITS, type Page } from '@teamtrack/shared';
import { Board, type IBoard, type IBoardFile } from '../../models/Board';
import { BoardSnapshot, type IBoardSnapshot } from '../../models/BoardSnapshot';
import { paginate } from '../../db/pagination';
import { updateVersioned } from '../../db/versioned';

/** What retention needs to decide and clean up; avoids loading whole snapshot documents. */
export type SnapshotStub = Pick<IBoardSnapshot, '_id' | 'createdAt' | 'storageKey'>;

export const boardRepository = {
  findById(workspaceId: Types.ObjectId, id: Types.ObjectId | string, session?: ClientSession) {
    return Board.findOne({ workspaceId, _id: id }).session(session ?? null).lean<IBoard>();
  },

  async create(doc: Partial<IBoard>, session: ClientSession): Promise<IBoard> {
    const [created] = await Board.create([doc], { session });
    return created!.toObject<IBoard>();
  },

  /** Most recently edited first. `projectIds` null = unrestricted (admins). */
  list(
    workspaceId: Types.ObjectId,
    opts: { projectIds: Types.ObjectId[] | null; limit: number; cursor?: string | undefined },
  ): Promise<Page<IBoard>> {
    const filter: FilterQuery<IBoard> = { workspaceId };
    if (opts.projectIds) filter.projectId = { $in: opts.projectIds };
    return paginate(Board, { filter, sortField: 'lastEditedAt', direction: -1, limit: opts.limit, cursor: opts.cursor, projection: { files: 0 } });
  },

  search(workspaceId: Types.ObjectId, projectIds: Types.ObjectId[] | null, title: RegExp, limit: number) {
    const filter: FilterQuery<IBoard> = { workspaceId, title };
    if (projectIds) filter.projectId = { $in: projectIds };
    return Board.find(filter, { files: 0 }).sort({ lastEditedAt: -1, _id: -1 }).limit(limit).lean<IBoard[]>();
  },

  rename(workspaceId: Types.ObjectId, id: Types.ObjectId, expectedVersion: number, title: string, actorId: Types.ObjectId, session?: ClientSession) {
    return updateVersioned(Board, { workspaceId, _id: id }, expectedVersion, { $set: { title, updatedBy: actorId } }, 'Board', session);
  },

  /**
   * Moves the board to a new snapshot if it is still at `fromSceneVersion` (the scene's optimistic lock).
   * Returns null when it moved on (or is gone). Leaves `version` alone: metadata and drawing are locked separately.
   */
  advanceScene(
    workspaceId: Types.ObjectId,
    id: Types.ObjectId,
    fromSceneVersion: number,
    set: Pick<IBoard, 'currentSnapshotId' | 'elementCount' | 'lastEditedBy' | 'lastEditedAt'>,
    session: ClientSession,
  ) {
    return Board.findOneAndUpdate(
      { workspaceId, _id: id, sceneVersion: fromSceneVersion },
      { $set: { ...set, sceneVersion: fromSceneVersion + 1 } },
      { new: true, runValidators: true, session },
    ).lean<IBoard>();
  },

  /** Registers an uploaded image unless the board already has the maximum. Returns null if full or gone. */
  addFile(workspaceId: Types.ObjectId, id: Types.ObjectId, file: IBoardFile) {
    return Board.findOneAndUpdate(
      { workspaceId, _id: id, [`files.${WHITEBOARD_LIMITS.maxFilesPerBoard - 1}`]: { $exists: false } },
      { $push: { files: file } },
      { new: true, runValidators: true, projection: { _id: 1 } },
    ).lean<Pick<IBoard, '_id'>>();
  },

  async setThumbnail(workspaceId: Types.ObjectId, id: Types.ObjectId, key: string): Promise<boolean> {
    const res = await Board.updateOne({ workspaceId, _id: id }, { $set: { thumbnailKey: key } }, { timestamps: false });
    return res.matchedCount === 1;
  },

  async softDelete(workspaceId: Types.ObjectId, id: Types.ObjectId, actorId: Types.ObjectId, session: ClientSession): Promise<boolean> {
    const res = await Board.updateOne({ workspaceId, _id: id }, { $set: { deletedAt: new Date(), deletedBy: actorId }, $inc: { version: 1 } }, { session });
    return res.modifiedCount === 1;
  },

  /** Cascade for project deletion (join the project's transaction). */
  async softDeleteByProject(workspaceId: Types.ObjectId, projectId: Types.ObjectId, actorId: Types.ObjectId, session: ClientSession): Promise<void> {
    await Board.updateMany({ workspaceId, projectId }, { $set: { deletedAt: new Date(), deletedBy: actorId }, $inc: { version: 1 } }, { session });
  },
};

export const snapshotRepository = {
  async create(doc: Partial<IBoardSnapshot>, session: ClientSession): Promise<IBoardSnapshot> {
    const [created] = await BoardSnapshot.create([doc], { session });
    return created!.toObject<IBoardSnapshot>();
  },

  findById(workspaceId: Types.ObjectId, boardId: Types.ObjectId, id: Types.ObjectId | string) {
    return BoardSnapshot.findOne({ workspaceId, boardId, _id: id }).lean<IBoardSnapshot>();
  },

  /** Newest first. */
  listForBoard(workspaceId: Types.ObjectId, boardId: Types.ObjectId, limit: number) {
    return BoardSnapshot.find({ workspaceId, boardId }).sort({ sceneVersion: -1 }).limit(limit).lean<IBoardSnapshot[]>();
  },

  /** Every snapshot of a board, newest first, as stubs. Retention keeps this list short (latest N + one per day). */
  stubs(workspaceId: Types.ObjectId, boardId: Types.ObjectId, session: ClientSession) {
    return BoardSnapshot.find({ workspaceId, boardId }, { _id: 1, createdAt: 1, storageKey: 1 })
      .sort({ sceneVersion: -1 })
      .session(session)
      .lean<SnapshotStub[]>();
  },

  async deleteMany(workspaceId: Types.ObjectId, ids: Types.ObjectId[], session: ClientSession): Promise<void> {
    if (ids.length) await BoardSnapshot.deleteMany({ workspaceId, _id: { $in: ids } }, { session });
  },
};
