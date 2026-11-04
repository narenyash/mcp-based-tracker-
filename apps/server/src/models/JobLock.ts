import { model } from 'mongoose';
import { createSchema } from '../db/schema';

/** One row per scheduled job: a lease so only one server instance runs it at a time, and when it runs next. */
export interface IJobLock {
  _id: string;
  lockedUntil: Date | null;
  nextRunAt: Date;
  lastRunAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const schema = createSchema<IJobLock>(
  {
    _id: { type: String, required: true },
    lockedUntil: { type: Date, default: null },
    nextRunAt: { type: Date, required: true },
    lastRunAt: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 2000 },
  },
  { collection: 'jobLocks', audit: false },
);

export const JobLock = model<IJobLock>('JobLock', schema);
