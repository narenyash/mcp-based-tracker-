import type { ClientSession, FilterQuery, Types } from 'mongoose';
import type { EntityType, Page } from '@teamtrack/shared';
import { Comment, type IComment } from '../../models/Comment';
import { Attachment, type IAttachment } from '../../models/Attachment';
import { Activity, type IActivity } from '../../models/Activity';
import { decodeCursor, encodeCursor, paginate } from '../../db/pagination';
import { updateVersioned } from '../../db/versioned';

interface EntityKey {
  workspaceId: Types.ObjectId;
  entityType: EntityType;
  entityId: Types.ObjectId;
}

export const commentRepository = {
  findById(workspaceId: Types.ObjectId, id: Types.ObjectId | string, session?: ClientSession) {
    return Comment.findOne({ workspaceId, _id: id }).session(session ?? null).lean<IComment>();
  },

  /**
   * A thread, oldest first. Deleted comments are included while they still have replies (shown as
   * "deleted"), so replies never lose their context. Keyset on (createdAt, _id).
   */
  async thread(key: EntityKey, limit: number, cursor?: string): Promise<Page<IComment>> {
    const filter: FilterQuery<IComment> = { ...key, $or: [{ deletedAt: null }, { replyCount: { $gt: 0 } }] };
    if (cursor) {
      const { value, id } = decodeCursor(cursor);
      filter.$and = [{ $or: [{ createdAt: { $gt: value } }, { createdAt: value, _id: { $gt: id } }] }];
    }
    const docs = await Comment.find(filter)
      .setOptions({ withDeleted: true })
      .sort({ createdAt: 1, _id: 1 })
      .limit(limit + 1)
      .lean<IComment[]>();
    const hasMore = docs.length > limit;
    const items = hasMore ? docs.slice(0, limit) : docs;
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last.createdAt, last._id) : null };
  },

  async create(doc: Partial<IComment>, session: ClientSession): Promise<IComment> {
    const [created] = await Comment.create([doc], { session });
    return created!.toObject<IComment>();
  },

  updateBody(workspaceId: Types.ObjectId, id: Types.ObjectId, expectedVersion: number, set: Pick<IComment, 'body' | 'mentionUserIds'>, actorId: Types.ObjectId, session?: ClientSession) {
    return updateVersioned(Comment, { workspaceId, _id: id }, expectedVersion, { $set: { ...set, editedAt: new Date(), updatedBy: actorId } }, 'Comment', session);
  },

  async softDelete(workspaceId: Types.ObjectId, id: Types.ObjectId, actorId: Types.ObjectId, session: ClientSession): Promise<IComment | null> {
    return Comment.findOneAndUpdate(
      { workspaceId, _id: id },
      { $set: { deletedAt: new Date(), deletedBy: actorId }, $inc: { version: 1 } },
      { new: true, session },
    ).lean<IComment>();
  },

  /** Keeps the parent's live-reply counter in step with reply creates and deletes (inside their transaction). */
  async adjustReplies(workspaceId: Types.ObjectId, parentId: Types.ObjectId, by: 1 | -1, session: ClientSession): Promise<void> {
    await Comment.updateOne({ workspaceId, _id: parentId }, { $inc: { replyCount: by } }, { session }).setOptions({ withDeleted: true });
  },
};

export const attachmentRepository = {
  findById(workspaceId: Types.ObjectId, id: Types.ObjectId | string) {
    return Attachment.findOne({ workspaceId, _id: id }).lean<IAttachment>();
  },

  /** Every live attachment of an entity, oldest first. Bounded by the per-entity limit. */
  listForEntity(key: EntityKey, limit: number) {
    return Attachment.find(key).sort({ createdAt: 1, _id: 1 }).limit(limit).lean<IAttachment[]>();
  },

  countForEntity(key: EntityKey, session?: ClientSession) {
    return Attachment.countDocuments(key).session(session ?? null);
  },

  async create(doc: Partial<IAttachment>, session: ClientSession): Promise<IAttachment> {
    const [created] = await Attachment.create([doc], { session });
    return created!.toObject<IAttachment>();
  },

  async softDelete(workspaceId: Types.ObjectId, id: Types.ObjectId, actorId: Types.ObjectId, session: ClientSession): Promise<boolean> {
    const res = await Attachment.updateOne({ workspaceId, _id: id }, { $set: { deletedAt: new Date(), deletedBy: actorId }, $inc: { version: 1 } }, { session });
    return res.modifiedCount === 1;
  },
};

export const activityRepository = {
  /** Appends entries, inside the caller's transaction when a session is given. */
  async insert(docs: Omit<IActivity, '_id' | 'version'>[], session: ClientSession | null): Promise<void> {
    if (docs.length) await Activity.insertMany(docs, session ? { session } : {});
  },

  forEntity(key: EntityKey, limit: number, cursor?: string): Promise<Page<IActivity>> {
    return paginate(Activity, { filter: key, sortField: 'at', direction: -1, limit, cursor });
  },

  forProject(workspaceId: Types.ObjectId, projectId: Types.ObjectId, limit: number, cursor?: string): Promise<Page<IActivity>> {
    return paginate(Activity, { filter: { workspaceId, projectId }, sortField: 'at', direction: -1, limit, cursor });
  },
};
