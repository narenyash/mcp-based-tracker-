import type { ClientSession, Types } from 'mongoose';
import { JoinLink, type IJoinLink } from '../models/JoinLink';

const active = () => ({ revokedAt: null, expiresAt: { $gt: new Date() } });

export const joinLinkRepository = {
  async create(doc: Partial<IJoinLink>, session: ClientSession): Promise<IJoinLink> {
    const [created] = await JoinLink.create([doc], { session });
    return created!.toObject<IJoinLink>();
  },

  findActive(workspaceId: Types.ObjectId) {
    return JoinLink.findOne({ workspaceId, ...active() }).lean<IJoinLink>();
  },

  /** Cross-workspace lookup by secret token (the token itself identifies the tenant). */
  findActiveByTokenHash(tokenHash: string, session?: ClientSession) {
    return JoinLink.findOne({ tokenHash, ...active() })
      .setOptions({ skipTenant: true })
      .session(session ?? null)
      .lean<IJoinLink>();
  },

  /** Revokes expired links too, because they still hold the workspace's one-live-link slot until purged. */
  async revokeLive(workspaceId: Types.ObjectId, session?: ClientSession): Promise<number> {
    const res = await JoinLink.updateMany({ workspaceId, revokedAt: null }, { $set: { revokedAt: new Date() } }, session ? { session } : {});
    return res.modifiedCount;
  },

  async recordUse(workspaceId: Types.ObjectId, id: Types.ObjectId, session: ClientSession): Promise<void> {
    await JoinLink.updateOne({ workspaceId, _id: id }, { $inc: { useCount: 1 } }, { session });
  },
};
