import type { ClientSession, Types } from 'mongoose';
import { Session, type ISession } from '../models/Session';

/** Pipeline update: stamps endedAt on every row, and revokedAt only where it is not already set. */
const endFamily = () => {
  const now = new Date();
  return [{ $set: { endedAt: now, revokedAt: { $ifNull: ['$revokedAt', now] } } }];
};

export const sessionRepository = {
  async create(doc: Omit<ISession, 'createdAt' | 'updatedAt' | 'version' | 'revokedAt' | 'replacedBy' | 'endedAt'>, session?: ClientSession) {
    const [created] = await Session.create([doc], { session: session ?? null });
    return created!.toObject<ISession>();
  },

  findByTokenHash(tokenHash: string) {
    return Session.findOne({ tokenHash }).lean<ISession>();
  },

  /** Atomically marks a live session as rotated. Returns null if someone else rotated it first. */
  markRotated(id: Types.ObjectId, replacedBy: Types.ObjectId, session: ClientSession) {
    return Session.findOneAndUpdate(
      { _id: id, revokedAt: null },
      { $set: { revokedAt: new Date(), replacedBy } },
      { new: true, session },
    ).lean<ISession>();
  },

  /**
   * True while the access token's session family is still live. A rotated row stays valid here (its
   * access tokens remain good until they expire); only an ended family or an expired row fails.
   * One indexed _id lookup, cheap enough for every request and socket handshake.
   */
  async isSessionActive(sessionId: Types.ObjectId, workspaceId: Types.ObjectId): Promise<boolean> {
    return (await Session.exists({ _id: sessionId, workspaceId, endedAt: null, expiresAt: { $gt: new Date() } })) !== null;
  },

  /** Ends the family `id` belongs to: logging out kills that device's earlier access tokens too. */
  async revoke(id: Types.ObjectId): Promise<void> {
    const row = await Session.findOne({ _id: id }).select({ familyId: 1 }).lean<Pick<ISession, 'familyId'>>();
    if (row) await this.revokeFamily(row.familyId);
  },

  async revokeFamily(familyId: Types.ObjectId): Promise<void> {
    await Session.updateMany({ familyId, endedAt: null }, endFamily());
  },

  async revokeAllForUser(userId: Types.ObjectId, session?: ClientSession): Promise<void> {
    await Session.updateMany({ userId, endedAt: null }, endFamily(), session ? { session } : {});
  },
};
