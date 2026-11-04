import { model, Schema, type Types } from 'mongoose';
import { ROLES, USER_STATUSES, type Role, type UserStatus } from '@teamtrack/shared';
import { CI_COLLATION, createSchema, NOT_DELETED } from '../db/schema';

export interface IUser {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  email: string;
  name: string;
  avatarKey: string | null;
  role: Role;
  status: UserStatus;
  passwordHash: string | null;
  passwordChangedAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastSeenAt: Date | null;
  notificationPrefs: {
    email: { assigned: boolean; testing: boolean; mentioned: boolean; dueSoon: boolean; digest: boolean };
  };
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const schema = createSchema<IUser>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    avatarKey: { type: String, default: null },
    role: { type: String, enum: ROLES, required: true },
    status: { type: String, enum: USER_STATUSES, required: true, default: 'active' },
    passwordHash: { type: String, default: null },
    passwordChangedAt: { type: Date, default: null },
    failedLoginCount: { type: Number, default: 0, min: 0 },
    lockedUntil: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
    notificationPrefs: {
      email: {
        assigned: { type: Boolean, default: true },
        testing: { type: Boolean, default: true },
        mentioned: { type: Boolean, default: true },
        dueSoon: { type: Boolean, default: true },
        digest: { type: Boolean, default: false },
      },
    },
  },
  { collection: 'users', softDelete: true, tenant: true },
);

schema.index(
  { workspaceId: 1, email: 1 },
  { unique: true, collation: CI_COLLATION, partialFilterExpression: NOT_DELETED },
);
schema.index({ workspaceId: 1, status: 1, name: 1, _id: 1 });
// Login looks a user up by email before the workspace is known.
schema.index({ email: 1 });

export const User = model<IUser>('User', schema);
