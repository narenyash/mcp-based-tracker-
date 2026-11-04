import { Types, type FilterQuery, type Model, type ProjectionType } from 'mongoose';
import { ValidationError } from '../errors/AppError';
import type { Page } from '@teamtrack/shared';

type CursorValue = string | number | Date | null;

interface CursorPayload {
  v: string | number | null;
  d?: 1; // value is a Date
  id: string;
}

export function encodeCursor(value: CursorValue, id: Types.ObjectId): string {
  const payload: CursorPayload =
    value instanceof Date ? { v: value.toISOString(), d: 1, id: id.toHexString() } : { v: value, id: id.toHexString() };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor: string): { value: CursorValue; id: Types.ObjectId } {
  try {
    const p = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
    if (!Types.ObjectId.isValid(p.id)) throw new Error('bad id');
    const value = p.d === 1 && typeof p.v === 'string' ? new Date(p.v) : p.v;
    return { value, id: new Types.ObjectId(p.id) };
  } catch {
    throw new ValidationError([{ path: 'cursor', message: 'Invalid cursor' }]);
  }
}

export interface PaginateOptions<T> {
  filter: FilterQuery<T>;
  sortField: string;
  direction: 1 | -1;
  limit: number;
  cursor?: string | undefined;
  projection?: ProjectionType<T>;
}

/** Keyset pagination on (sortField, _id). Stable under inserts; never uses skip(). */
export async function paginate<T>(model: Model<T>, opts: PaginateOptions<T>): Promise<Page<T>> {
  const filter: FilterQuery<T> = { ...opts.filter };
  if (opts.cursor) {
    const { value, id } = decodeCursor(opts.cursor);
    const op = opts.direction === 1 ? '$gt' : '$lt';
    const keyset = {
      $or: [{ [opts.sortField]: { [op]: value } }, { [opts.sortField]: value, _id: { [op]: id } }],
    };
    (filter as Record<string, unknown>).$and = [...((filter.$and as unknown[]) ?? []), keyset];
  }

  const docs = await model
    .find(filter, opts.projection)
    .sort({ [opts.sortField]: opts.direction, _id: opts.direction })
    .limit(opts.limit + 1)
    .lean<(T & { _id: Types.ObjectId })[]>();

  const hasMore = docs.length > opts.limit;
  const items = hasMore ? docs.slice(0, opts.limit) : docs;
  const last = items.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor((last as Record<string, unknown>)[opts.sortField] as CursorValue, last._id)
      : null;
  return { items, nextCursor };
}
