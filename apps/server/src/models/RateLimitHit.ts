import { model, type Types } from 'mongoose';
import { createSchema } from '../db/schema';

export interface IRateLimitHit {
  _id: Types.ObjectId;
  key: string;
  count: number;
  expiresAt: Date;
}

const schema = createSchema<IRateLimitHit>(
  {
    key: { type: String, required: true, maxlength: 400 },
    count: { type: Number, required: true, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'rateLimits', audit: false, timestamps: false },
);

schema.index({ key: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimitHit = model<IRateLimitHit>('RateLimitHit', schema);
