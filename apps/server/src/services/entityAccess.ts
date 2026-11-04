import { Types } from 'mongoose';
import { objectIdSchema, type EntityType } from '@teamtrack/shared';
import type { AuthContext } from '../auth/context';
import { NotFoundError } from '../errors/AppError';

/**
 * What generic features (comments, attachments, activity, notifications) need to know about a thing
 * without depending on its module. Each module registers a resolver for its entity type.
 */
export interface EntityInfo {
  type: EntityType;
  id: Types.ObjectId;
  /** null for things outside any project (e.g. personal goals). */
  projectId: Types.ObjectId | null;
  /** Shown in emails and notifications, e.g. "Website" or the workspace name. */
  projectName: string;
  /** Readable key, e.g. WEB-12, TCK-3, or a short goal title. */
  key: string;
  title: string;
  /** In-app path that opens it. */
  path: string;
  /** May the caller comment, attach files, and otherwise contribute? */
  canWrite: boolean;
  /** May the caller moderate (delete others' comments and attachments)? */
  canManage: boolean;
  /** People who care about new activity (reporter, assignee, tester, owner...). */
  participants: Types.ObjectId[];
}

/** Returns null if the entity doesn't exist OR the caller can't see it (both become 404). */
export type EntityResolver = (ctx: AuthContext, id: Types.ObjectId) => Promise<EntityInfo | null>;

const resolvers = new Map<EntityType, EntityResolver>();

export function registerEntity(type: EntityType, resolver: EntityResolver): void {
  if (resolvers.has(type)) throw new Error(`entity resolver for ${type} registered twice`);
  resolvers.set(type, resolver);
}

export async function resolveEntity(ctx: AuthContext, type: EntityType, id: string | Types.ObjectId): Promise<EntityInfo> {
  const resolver = resolvers.get(type);
  if (!resolver) throw new NotFoundError(type);
  if (typeof id === 'string' && !objectIdSchema.safeParse(id).success) throw new NotFoundError(type);
  const info = await resolver(ctx, typeof id === 'string' ? new Types.ObjectId(id) : id);
  if (!info) throw new NotFoundError(type);
  return info;
}
