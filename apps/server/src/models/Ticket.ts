import { model, Schema, type Types } from 'mongoose';
import {
  MAX_TICKET_LINKED_TASKS,
  STATUS_CATEGORIES,
  TICKET_RESOLUTIONS,
  TICKET_SEVERITIES,
  TICKET_TYPES,
  type StatusCategory,
  type TicketResolution,
  type TicketSeverity,
  type TicketType,
} from '@teamtrack/shared';
import { createSchema } from '../db/schema';
import { MAX_RANK_LENGTH, RANK_PATTERN } from '../db/rank';

export interface ITicketEnvironment {
  browser: string;
  os: string;
  url: string;
  version: string;
}

export interface ITicket {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId;
  /** Workspace-wide sequence (counter "<workspaceId>:ticket"); key is TCK-<number>. */
  number: number;
  key: string;
  title: string;
  description: string;
  type: TicketType;
  severity: TicketSeverity;
  severityRank: number;
  statusId: string;
  /** Denormalised from the project's ticket workflow; always derived server-side. */
  statusCategory: StatusCategory;
  assigneeId: Types.ObjectId | null;
  reporterId: Types.ObjectId;
  environment: ITicketEnvironment;
  stepsToReproduce: string;
  expected: string;
  actual: string;
  /** Set exactly while the ticket is in a done-category status. */
  resolution: TicketResolution | null;
  duplicateOfId: Types.ObjectId | null;
  resolvedAt: Date | null;
  resolvedBy: Types.ObjectId | null;
  reopenCount: number;
  labelIds: Types.ObjectId[];
  linkedTaskIds: Types.ObjectId[];
  rank: string;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const environment = new Schema<ITicketEnvironment>(
  {
    browser: { type: String, default: '', trim: true, maxlength: 300 },
    os: { type: String, default: '', trim: true, maxlength: 300 },
    url: { type: String, default: '', trim: true, maxlength: 2000 },
    version: { type: String, default: '', trim: true, maxlength: 300 },
  },
  { _id: false, strict: 'throw' },
);

const schema = createSchema<ITicket>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, immutable: true },
    number: { type: Number, required: true, min: 1, immutable: true },
    key: { type: String, required: true, immutable: true, maxlength: 16 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 20_000 },
    type: { type: String, enum: TICKET_TYPES, required: true },
    severity: { type: String, enum: TICKET_SEVERITIES, required: true },
    severityRank: { type: Number, required: true, min: 1, max: 4 },
    statusId: { type: String, required: true, match: /^[a-z][a-z0-9_]{1,31}$/ },
    statusCategory: { type: String, enum: STATUS_CATEGORIES, required: true },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    environment: { type: environment, default: () => ({}) },
    stepsToReproduce: { type: String, default: '', maxlength: 5_000 },
    expected: { type: String, default: '', maxlength: 5_000 },
    actual: { type: String, default: '', maxlength: 5_000 },
    resolution: { type: String, enum: [...TICKET_RESOLUTIONS, null], default: null },
    duplicateOfId: { type: Schema.Types.ObjectId, ref: 'Ticket', default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reopenCount: { type: Number, default: 0, min: 0 },
    labelIds: {
      type: [Schema.Types.ObjectId],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= 20, message: 'At most 20 labels' },
    },
    linkedTaskIds: {
      type: [Schema.Types.ObjectId],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= MAX_TICKET_LINKED_TASKS, message: `At most ${MAX_TICKET_LINKED_TASKS} linked tasks` },
    },
    rank: { type: String, required: true, match: RANK_PATTERN, maxlength: MAX_RANK_LENGTH },
  },
  { collection: 'tickets', softDelete: true, tenant: true },
);

// Readable keys are workspace-wide and never reused, even after deletion, so no partial filter.
schema.index({ workspaceId: 1, number: 1 }, { unique: true });
// Board: one column, in order.
schema.index({ workspaceId: 1, projectId: 1, statusId: 1, rank: 1 });
// Project list views.
schema.index({ workspaceId: 1, projectId: 1, updatedAt: -1, _id: -1 });
// Workspace-wide lists ("assigned to me", "reported by me").
schema.index({ workspaceId: 1, assigneeId: 1, statusCategory: 1, updatedAt: -1 });
schema.index({ workspaceId: 1, reporterId: 1, updatedAt: -1 });
// Label filter, and "which tickets link this task".
schema.index({ workspaceId: 1, labelIds: 1 });
schema.index({ workspaceId: 1, linkedTaskIds: 1 });

export const Ticket = model<ITicket>('Ticket', schema);
