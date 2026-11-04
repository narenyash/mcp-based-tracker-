import { model, type Types } from 'mongoose';
import { createSchema } from '../db/schema';

/** A client-supplied Idempotency-Key on a POST: first a lease while the request runs, then the stored 2xx response. */
export interface IIdempotencyKey {
  _id: Types.ObjectId;
  /** `<userId>:<client key>`; keys are scoped per user so one user can't replay another's response. */
  key: string;
  userId: Types.ObjectId;
  method: string;
  path: string;
  requestHash: string;
  state: 'processing' | 'done';
  responseStatus: number | null;
  responseBody: unknown;
  expiresAt: Date;
}

const schema = createSchema<IIdempotencyKey>(
  {
    key: { type: String, required: true, maxlength: 300 },
    userId: { type: 'ObjectId', required: true },
    method: { type: String, required: true, maxlength: 10 },
    path: { type: String, required: true, maxlength: 500 },
    requestHash: { type: String, required: true, maxlength: 64 },
    state: { type: String, required: true, enum: ['processing', 'done'] },
    responseStatus: { type: Number, default: null },
    responseBody: { type: 'Mixed', default: null },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'idempotencyKeys', audit: false, timestamps: false },
);

schema.index({ key: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyKey = model<IIdempotencyKey>('IdempotencyKey', schema);
