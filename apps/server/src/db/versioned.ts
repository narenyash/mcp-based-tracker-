import type { ClientSession, FilterQuery, Model, UpdateQuery } from 'mongoose';
import { NotFoundError, StaleVersionError } from '../errors/AppError';

/**
 * Optimistic-concurrency update: applies `update` only if the document is still at
 * `expectedVersion`, then bumps the version. Distinguishes "gone" (404) from "changed" (409).
 */
export async function updateVersioned<T>(
  model: Model<T>,
  filter: FilterQuery<T>,
  expectedVersion: number,
  update: UpdateQuery<T>,
  resource: string,
  session?: ClientSession,
): Promise<T> {
  const updated = await model
    .findOneAndUpdate(
      { ...filter, version: expectedVersion } as FilterQuery<T>,
      { ...update, $inc: { ...((update.$inc as object) ?? {}), version: 1 } } as UpdateQuery<T>,
      { new: true, runValidators: true, session: session ?? null },
    )
    .lean<T>();
  if (updated) return updated;

  const exists = await model.exists(filter).session(session ?? null);
  if (!exists) throw new NotFoundError(resource);
  throw new StaleVersionError();
}
