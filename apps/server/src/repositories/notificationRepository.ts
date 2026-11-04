import type { Types } from 'mongoose';
import type { Page } from '@teamtrack/shared';
import { paginate } from '../db/pagination';
import { Notification, type INotification } from '../models/Notification';

type NewNotification = Omit<INotification, '_id' | 'readAt' | 'createdAt' | 'updatedAt' | 'version'>;

export const notificationRepository = {
  /** Inserts unless a notification with the same sourceKey exists. `created` is false on a retried delivery. */
  async insertOnce(data: NewNotification): Promise<{ doc: INotification; created: boolean }> {
    const res = await Notification.findOneAndUpdate(
      { workspaceId: data.workspaceId, sourceKey: data.sourceKey },
      { $setOnInsert: { ...data, readAt: null } },
      { upsert: true, new: true, includeResultMetadata: true, lean: true },
    );
    return { doc: res.value as INotification, created: !res.lastErrorObject?.updatedExisting };
  },

  list(workspaceId: Types.ObjectId, userId: Types.ObjectId, opts: { unread?: boolean | undefined; limit: number; cursor?: string | undefined }): Promise<Page<INotification>> {
    return paginate(Notification, {
      filter: { workspaceId, userId, ...(opts.unread ? { readAt: null } : {}) },
      sortField: 'createdAt',
      direction: -1,
      limit: opts.limit,
      cursor: opts.cursor,
    });
  },

  /** Capped so the badge query stays cheap; the UI shows "99+". */
  countUnread(workspaceId: Types.ObjectId, userId: Types.ObjectId, cap = 100): Promise<number> {
    return Notification.countDocuments({ workspaceId, userId, readAt: null }).limit(cap);
  },

  async markRead(workspaceId: Types.ObjectId, userId: Types.ObjectId, id: Types.ObjectId): Promise<boolean> {
    const res = await Notification.updateOne({ workspaceId, userId, _id: id }, [{ $set: { readAt: { $ifNull: ['$readAt', '$$NOW'] } } }]);
    return res.matchedCount === 1;
  },

  async markAllRead(workspaceId: Types.ObjectId, userId: Types.ObjectId): Promise<number> {
    const res = await Notification.updateMany({ workspaceId, userId, readAt: null }, { $set: { readAt: new Date() } });
    return res.modifiedCount;
  },
};
