import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '../db/schema';

export interface IEmailLog {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId | null;
  to: string;
  template: string;
  subject: string;
  providerMessageId: string | null;
  status: 'sent' | 'failed';
  error: string | null;
  outboxId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const schema = createSchema<IEmailLog>(
  {
    workspaceId: { type: Schema.Types.ObjectId, default: null },
    to: { type: String, required: true },
    template: { type: String, required: true },
    subject: { type: String, required: true },
    providerMessageId: { type: String, default: null },
    status: { type: String, enum: ['sent', 'failed'], required: true },
    error: { type: String, default: null, maxlength: 2000 },
    outboxId: { type: Schema.Types.ObjectId, default: null },
  },
  { collection: 'emailLogs', audit: false },
);

schema.index({ workspaceId: 1, createdAt: -1 });
schema.index({ to: 1, createdAt: -1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

export const EmailLog = model<IEmailLog>('EmailLog', schema);
