import { model, Schema, type Types } from 'mongoose';
import { ROLES, type Role } from '@teamtrack/shared';
import { CI_COLLATION, createSchema } from '../db/schema';

export interface IInvite {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  email: string;
  role: Role;
  projectIds: Types.ObjectId[];
  tokenHash: string;
  invitedBy: Types.ObjectId;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const schema = createSchema<IInvite>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    role: { type: String, enum: ROLES, required: true },
    projectIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Project' }],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= 50, message: 'Too many projects' },
    },
    tokenHash: { type: String, required: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { collection: 'invites', tenant: true },
);

schema.index({ tokenHash: 1 }, { unique: true });
// One pending invite per email per workspace.
schema.index(
  { workspaceId: 1, email: 1 },
  {
    unique: true,
    collation: CI_COLLATION,
    partialFilterExpression: { acceptedAt: null, revokedAt: null },
  },
);
schema.index({ workspaceId: 1, createdAt: -1 });
// Expired invites are purged by Mongo; accepted ones are kept for 30 days after expiry.
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const Invite = model<IInvite>('Invite', schema);
