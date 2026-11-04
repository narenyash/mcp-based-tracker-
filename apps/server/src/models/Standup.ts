import { model, Schema, type Types } from 'mongoose';
import { STANDUP_MAX_BLOCKER_TASKS, STANDUP_TEXT_MAX } from '@teamtrack/shared';
import { createSchema } from '../db/schema';

/** One person's daily standup. One per user per workspace-local day. */
export interface IStandup {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  userId: Types.ObjectId;
  projectId: Types.ObjectId | null;
  /** "YYYY-MM-DD" in the workspace timezone. */
  dateKey: string;
  /** That day at 00:00 UTC (the same convention as due dates). */
  date: Date;
  yesterday: string;
  today: string;
  blockers: string;
  blockerTaskIds: Types.ObjectId[];
  mood: number | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const text = { type: String, default: '', trim: true, maxlength: STANDUP_TEXT_MAX };

const schema = createSchema<IStandup>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, immutable: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
    dateKey: { type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    date: { type: Date, required: true, immutable: true },
    yesterday: text,
    today: text,
    blockers: text,
    blockerTaskIds: {
      type: [Schema.Types.ObjectId],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= STANDUP_MAX_BLOCKER_TASKS, message: `At most ${STANDUP_MAX_BLOCKER_TASKS} blocking tasks` },
    },
    mood: { type: Number, default: null, min: 1, max: 5 },
  },
  { collection: 'standups', tenant: true },
);

// One standup per person per day; also serves "my history" newest first.
schema.index({ workspaceId: 1, userId: 1, dateKey: 1 }, { unique: true });
// Team feed for a day, optionally per project.
schema.index({ workspaceId: 1, dateKey: 1, projectId: 1 });

export const Standup = model<IStandup>('Standup', schema);
