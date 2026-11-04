import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '../db/schema';

/** A reusable link anyone can use to join a workspace as a member, unlike an Invite, which is for one email. */
export interface IJoinLink {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  tokenHash: string;
  createdBy: Types.ObjectId;
  expiresAt: Date;
  revokedAt: Date | null;
  useCount: number;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const schema = createSchema<IJoinLink>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    useCount: { type: Number, default: 0, min: 0 },
  },
  { collection: 'joinLinks', tenant: true },
);

schema.index({ tokenHash: 1 }, { unique: true });
// One live link per workspace: generating a new one revokes the old one.
schema.index({ workspaceId: 1 }, { unique: true, partialFilterExpression: { revokedAt: null } });
// Dead links are purged by Mongo 30 days after they expire.
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const JoinLink = model<IJoinLink>('JoinLink', schema);
