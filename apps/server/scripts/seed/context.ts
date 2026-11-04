import type { Types } from 'mongoose';

/** What module seeders get from the core demo seed. */
export interface SeedContext {
  workspaceId: Types.ObjectId;
  /** The "WEB" project (Website). Lead: manager; members: member, admin. */
  projectId: Types.ObjectId;
  users: { owner: Types.ObjectId; admin: Types.ObjectId; manager: Types.ObjectId; member: Types.ObjectId };
  /** Demo task ids WEB-1..WEB-6 in order. */
  taskIds: Types.ObjectId[];
}
