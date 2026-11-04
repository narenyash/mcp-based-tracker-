import type { FilterQuery, Types } from 'mongoose';
import type { ListUsersQuery, Page } from '@teamtrack/shared';
import { User, type IUser } from '../../models/User';
import { paginate } from '../../db/pagination';

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The workspace directory narrowed to a set of people (a guest's project peers). */
export const peerDirectory = {
  list(workspaceId: Types.ObjectId, q: ListUsersQuery, ids: Types.ObjectId[]): Promise<Page<IUser>> {
    const filter: FilterQuery<IUser> = { workspaceId, _id: { $in: ids } };
    if (q.status) filter.status = q.status;
    if (q.q) {
      const rx = new RegExp(`^${escapeRegex(q.q)}`, 'i');
      filter.$or = [{ name: rx }, { email: rx }];
    }
    return paginate(User, { filter, sortField: 'name', direction: 1, limit: q.limit, cursor: q.cursor });
  },
};
