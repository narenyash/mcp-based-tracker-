import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '../db/schema';

/**
 * A refresh-token session. Tokens rotate on every refresh; reuse of a rotated token revokes the family.
 * `revokedAt` marks a row whose refresh token is spent (rotated or revoked); `endedAt` marks the whole
 * family as over (logout, log-out-everywhere, reuse, suspension). Access tokens carry a row id that may
 * since have been rotated, so they are checked against `endedAt`, not `revokedAt`.
 */
export interface ISession {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  userId: Types.ObjectId;
  familyId: Types.ObjectId;
  tokenHash: string;
  userAgent: string;
  ip: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: Types.ObjectId | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const schema = createSchema<ISession>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    familyId: { type: Schema.Types.ObjectId, required: true },
    tokenHash: { type: String, required: true },
    userAgent: { type: String, default: '', maxlength: 512 },
    ip: { type: String, default: '', maxlength: 64 },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    replacedBy: { type: Schema.Types.ObjectId, default: null },
    endedAt: { type: Date, default: null },
  },
  { collection: 'sessions', audit: false },
);

schema.index({ tokenHash: 1 }, { unique: true });
schema.index({ userId: 1, endedAt: 1 });
schema.index({ familyId: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = model<ISession>('Session', schema);
