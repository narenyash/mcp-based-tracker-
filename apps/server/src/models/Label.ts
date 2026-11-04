import { model, Schema, type Types } from 'mongoose';
import { CI_COLLATION, createSchema } from '../db/schema';

export interface ILabel {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId;
  name: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const schema = createSchema<ILabel>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    color: { type: String, required: true, match: /^#[0-9a-f]{6}$/i },
  },
  { collection: 'labels', tenant: true },
);

// Labels are hard-deleted (and pulled from tasks), so a plain unique index is enough.
schema.index({ workspaceId: 1, projectId: 1, name: 1 }, { unique: true, collation: CI_COLLATION });

export const Label = model<ILabel>('Label', schema);
