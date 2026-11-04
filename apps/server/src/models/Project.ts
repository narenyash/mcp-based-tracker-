import { model, Schema, type Types } from 'mongoose';
import {
  PROJECT_STATUSES,
  PROJECT_VISIBILITIES,
  STATUS_CATEGORIES,
  type ProjectStatus,
  type ProjectVisibility,
  type StatusCategory,
} from '@teamtrack/shared';
import { CI_COLLATION, createSchema, NOT_DELETED } from '../db/schema';

export interface IWorkflowStatus {
  id: string;
  name: string;
  category: StatusCategory;
  color: string;
  order: number;
}

export interface IProject {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  key: string;
  name: string;
  description: string;
  color: string;
  visibility: ProjectVisibility;
  status: ProjectStatus;
  leadId: Types.ObjectId;
  memberCount: number;
  workflow: { taskStatuses: IWorkflowStatus[]; ticketStatuses: IWorkflowStatus[] };
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const workflowStatus = new Schema<IWorkflowStatus>(
  {
    id: { type: String, required: true, match: /^[a-z][a-z0-9_]{1,31}$/ },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    category: { type: String, enum: STATUS_CATEGORIES, required: true },
    color: { type: String, required: true, match: /^#[0-9a-f]{6}$/i },
    order: { type: Number, required: true },
  },
  { _id: false, strict: 'throw' },
);

const statusList = {
  type: [workflowStatus],
  validate: {
    validator: (v: IWorkflowStatus[]) =>
      v.length >= 2 && v.length <= 12 && new Set(v.map((s) => s.id)).size === v.length,
    message: 'Workflow needs 2-12 statuses with unique ids',
  },
};

const schema = createSchema<IProject>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    key: { type: String, required: true, uppercase: true, match: /^[A-Z][A-Z0-9]{1,9}$/, immutable: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: '', maxlength: 2000 },
    color: { type: String, default: '#525252', match: /^#[0-9a-f]{6}$/i },
    visibility: { type: String, enum: PROJECT_VISIBILITIES, default: 'workspace' },
    status: { type: String, enum: PROJECT_STATUSES, default: 'active' },
    leadId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    memberCount: { type: Number, default: 0, min: 0 },
    workflow: {
      taskStatuses: statusList,
      ticketStatuses: statusList,
    },
  },
  { collection: 'projects', softDelete: true, tenant: true },
);

schema.index(
  { workspaceId: 1, key: 1 },
  { unique: true, collation: CI_COLLATION, partialFilterExpression: NOT_DELETED },
);
schema.index({ workspaceId: 1, status: 1, name: 1, _id: 1 });

export const Project = model<IProject>('Project', schema);

export const DEFAULT_TASK_STATUSES: IWorkflowStatus[] = [
  { id: 'todo', name: 'To do', category: 'todo', color: '#a3a3a3', order: 0 },
  { id: 'in_progress', name: 'In progress', category: 'in_progress', color: '#3b82f6', order: 1 },
  { id: 'review', name: 'Review', category: 'in_progress', color: '#a855f7', order: 2 },
  { id: 'testing', name: 'Testing', category: 'testing', color: '#f59e0b', order: 3 },
  { id: 'done', name: 'Done', category: 'done', color: '#22c55e', order: 4 },
];

export const TESTING_STATUS: IWorkflowStatus = DEFAULT_TASK_STATUSES.find((s) => s.category === 'testing')!;

export const DEFAULT_TICKET_STATUSES: IWorkflowStatus[] = [
  { id: 'open', name: 'Open', category: 'todo', color: '#a3a3a3', order: 0 },
  { id: 'triaged', name: 'Triaged', category: 'todo', color: '#f59e0b', order: 1 },
  { id: 'in_progress', name: 'In progress', category: 'in_progress', color: '#3b82f6', order: 2 },
  { id: 'resolved', name: 'Resolved', category: 'done', color: '#22c55e', order: 3 },
  { id: 'closed', name: 'Closed', category: 'done', color: '#525252', order: 4 },
];
