import { model, Schema, type Types } from 'mongoose';
import { ENTITY_TYPES, NOTIFICATION_TYPES, type EntityType, type NotificationType } from '@teamtrack/shared';
import { createSchema } from '../db/schema';

export const NOTIFICATION_TTL_DAYS = 90;

/** One in-app notification for one user. Snapshots (actor, entity key/title) keep the bell free of joins. */
export interface INotification {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  userId: Types.ObjectId;
  type: NotificationType;
  actor: { id: Types.ObjectId; name: string } | null;
  projectId: Types.ObjectId | null;
  entityType: EntityType | null;
  entityId: Types.ObjectId | null;
  entityKey: string | null;
  title: string;
  body: string;
  note: string;
  path: string;
  /** The outbox dedupe key that produced it; unique, so a retried delivery never duplicates. */
  sourceKey: string;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const actor = new Schema(
  { id: { type: Schema.Types.ObjectId, required: true }, name: { type: String, required: true, maxlength: 80 } },
  { _id: false, strict: 'throw' },
);

const schema = createSchema<INotification>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    actor: { type: actor, default: null },
    projectId: { type: Schema.Types.ObjectId, default: null },
    entityType: { type: String, enum: ENTITY_TYPES, default: null },
    entityId: { type: Schema.Types.ObjectId, default: null },
    entityKey: { type: String, default: null, maxlength: 40 },
    title: { type: String, required: true, maxlength: 300 },
    body: { type: String, default: '', maxlength: 300 },
    note: { type: String, default: '', maxlength: 2000 },
    path: { type: String, required: true, maxlength: 300 },
    sourceKey: { type: String, required: true, maxlength: 200 },
    readAt: { type: Date, default: null },
  },
  { collection: 'notifications', tenant: true, audit: false },
);

schema.index({ sourceKey: 1 }, { unique: true });
// The bell: newest first, keyset-paginated.
schema.index({ workspaceId: 1, userId: 1, createdAt: -1, _id: -1 });
// Unread badge and "mark all read" only touch unread rows.
schema.index({ workspaceId: 1, userId: 1, createdAt: -1 }, { name: 'unread_by_user', partialFilterExpression: { readAt: null } });
schema.index({ createdAt: 1 }, { expireAfterSeconds: NOTIFICATION_TTL_DAYS * 24 * 3600 });

export const Notification = model<INotification>('Notification', schema);
