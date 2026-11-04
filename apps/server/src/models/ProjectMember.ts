import { model, Schema, type Types } from 'mongoose';
import { PROJECT_ROLES, type ProjectRole } from '@teamtrack/shared';
import { createSchema } from '../db/schema';

export interface IProjectMember {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId;
  userId: Types.ObjectId;
  role: ProjectRole;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const schema = createSchema<IProjectMember>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: PROJECT_ROLES, required: true },
  },
  { collection: 'projectMembers', tenant: true },
);

schema.index({ workspaceId: 1, projectId: 1, userId: 1 }, { unique: true });
schema.index({ workspaceId: 1, userId: 1 });

export const ProjectMember = model<IProjectMember>('ProjectMember', schema);
