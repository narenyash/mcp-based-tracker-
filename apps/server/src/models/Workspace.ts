import { model, Schema, type Types } from 'mongoose';
import { CI_COLLATION, createSchema, NOT_DELETED } from '../db/schema';

export interface IWorkspace {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  timezone: string;
  ownerId: Types.ObjectId | null;
  settings: {
    workWeek: number[];
    standupTime: string;
    reminderLeadHours: number;
  };
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const schema = createSchema<IWorkspace>(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    slug: { type: String, required: true, lowercase: true, maxlength: 48 },
    timezone: { type: String, required: true, default: 'Asia/Kolkata' },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    settings: {
      workWeek: { type: [Number], default: [1, 2, 3, 4, 5] },
      standupTime: { type: String, default: '10:00', match: /^\d{2}:\d{2}$/ },
      reminderLeadHours: { type: Number, default: 24, min: 1, max: 168 },
    },
  },
  { collection: 'workspaces', softDelete: true },
);

schema.index({ slug: 1 }, { unique: true, collation: CI_COLLATION, partialFilterExpression: NOT_DELETED });

export const Workspace = model<IWorkspace>('Workspace', schema);
