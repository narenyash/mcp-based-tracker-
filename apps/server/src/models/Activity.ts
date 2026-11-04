import { model, Schema, type MongooseQueryMiddleware, type Types } from 'mongoose';
import { ENTITY_TYPES, type EntityType } from '@teamtrack/shared';
import { createSchema } from '../db/schema';

export const ACTIVITY_TTL_DAYS = 730;
export const MAX_ACTIVITY_CHANGES = 50;

export interface IActivityChange {
  field: string;
  from: string | null;
  to: string | null;
}

/** Append-only history. Rows are written in the transaction of the change they describe and never edited. */
export interface IActivity {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId | null;
  entityType: EntityType;
  entityId: Types.ObjectId;
  entityKey: string;
  actorId: Types.ObjectId;
  action: string;
  changes: IActivityChange[];
  at: Date;
  version: number;
}

const change = new Schema<IActivityChange>(
  {
    field: { type: String, required: true, maxlength: 40 },
    from: { type: String, default: null, maxlength: 300 },
    to: { type: String, default: null, maxlength: 300 },
  },
  { _id: false, strict: 'throw' },
);

const schema = createSchema<IActivity>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    projectId: { type: Schema.Types.ObjectId, default: null },
    entityType: { type: String, enum: ENTITY_TYPES, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    entityKey: { type: String, required: true, maxlength: 80 },
    actorId: { type: Schema.Types.ObjectId, required: true },
    action: { type: String, required: true, match: /^[a-z][a-z0-9_]{1,39}$/ },
    changes: {
      type: [change],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= MAX_ACTIVITY_CHANGES, message: `At most ${MAX_ACTIVITY_CHANGES} changes` },
    },
    at: { type: Date, required: true },
  },
  { collection: 'activities', tenant: true, timestamps: false, audit: false },
);

// The log is append-only: refuse updates at the model level so no code path can rewrite history.
const MUTATIONS: MongooseQueryMiddleware[] = ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne'];
schema.pre(MUTATIONS, function () {
  throw new Error('activities are append-only');
});

// One entity's history, newest first.
schema.index({ workspaceId: 1, entityType: 1, entityId: 1, at: -1, _id: -1 });
// A project's feed, newest first.
schema.index({ workspaceId: 1, projectId: 1, at: -1, _id: -1 });
schema.index({ at: 1 }, { expireAfterSeconds: ACTIVITY_TTL_DAYS * 24 * 3600 });

export const Activity = model<IActivity>('Activity', schema);
