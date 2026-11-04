import { model, Schema, type Types } from 'mongoose';
import { SNAKE_MAX_SCORE } from '@teamtrack/shared';
import { createSchema } from '../db/schema';

/** One person's snake record in a workspace: best score plus how many games they've finished. */
export interface ISnakeScore {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  userId: Types.ObjectId;
  best: number;
  bestAt: Date;
  games: number;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const schema = createSchema<ISnakeScore>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, immutable: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    best: { type: Number, required: true, min: 0, max: SNAKE_MAX_SCORE },
    bestAt: { type: Date, required: true },
    games: { type: Number, required: true, min: 0 },
  },
  { collection: 'snakeScores', tenant: true, audit: false },
);

schema.index({ workspaceId: 1, userId: 1 }, { unique: true });
// Leaderboard: highest first, earliest to reach it wins a tie.
schema.index({ workspaceId: 1, best: -1, bestAt: 1 });

export const SnakeScore = model<ISnakeScore>('SnakeScore', schema);
