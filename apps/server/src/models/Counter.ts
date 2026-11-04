import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '../db/schema';

/**
 * Per-project sequences for readable keys (WEB-42). `_id` is "<projectId>:<kind>". Incremented
 * inside the creating transaction, so an aborted create also rolls back its number.
 */
export interface ICounter {
  _id: string;
  workspaceId: Types.ObjectId;
  seq: number;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const schema = createSchema<ICounter>(
  {
    _id: { type: String, required: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    seq: { type: Number, required: true, min: 0 },
  },
  { collection: 'counters', audit: false },
);

export const Counter = model<ICounter>('Counter', schema);
