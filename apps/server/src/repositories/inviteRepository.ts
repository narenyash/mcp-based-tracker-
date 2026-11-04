import type { ClientSession, Types } from 'mongoose';
import { Invite, type IInvite } from '../models/Invite';

const pending = () => ({ acceptedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } });

export const inviteRepository = {
  async create(doc: Partial<IInvite>, session: ClientSession): Promise<IInvite> {
    const [created] = await Invite.create([doc], { session });
    return created!.toObject<IInvite>();
  },

  /** Cross-workspace lookup by secret token (the token itself identifies the tenant). */
  findPendingByTokenHash(tokenHash: string, session?: ClientSession) {
    return Invite.findOne({ tokenHash, ...pending() })
      .setOptions({ skipTenant: true })
      .session(session ?? null)
      .lean<IInvite>();
  },

  listPending(workspaceId: Types.ObjectId) {
    return Invite.find({ workspaceId, ...pending() }).sort({ createdAt: -1 }).limit(200).lean<IInvite[]>();
  },

  async revokePendingForEmail(workspaceId: Types.ObjectId, email: string, session: ClientSession): Promise<void> {
    await Invite.updateMany(
      { workspaceId, email, acceptedAt: null, revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { session },
    );
  },

  revoke(workspaceId: Types.ObjectId, id: Types.ObjectId | string) {
    return Invite.findOneAndUpdate(
      { workspaceId, _id: id, acceptedAt: null, revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { new: true },
    ).lean<IInvite>();
  },

  /** Claims the invite inside the accept transaction; null if it was accepted/revoked concurrently. */
  markAccepted(workspaceId: Types.ObjectId, id: Types.ObjectId, session: ClientSession) {
    return Invite.findOneAndUpdate(
      { workspaceId, _id: id, acceptedAt: null, revokedAt: null },
      { $set: { acceptedAt: new Date() } },
      { new: true, session },
    ).lean<IInvite>();
  },
};
