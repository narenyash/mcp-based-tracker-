import type { ClientSession, FilterQuery, Types } from 'mongoose';
import type { ListUsersQuery, Page, Role, UserStatus } from '@teamtrack/shared';
import { User, type IUser } from '../models/User';
import { paginate } from '../db/pagination';
import { updateVersioned } from '../db/versioned';

const LOCK_THRESHOLD = 5;
const LOCK_MS = 15 * 60_000;

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const userRepository = {
  findForAuth(workspaceId: Types.ObjectId, userId: Types.ObjectId) {
    return User.findOne({ workspaceId, _id: userId })
      .select({ _id: 1, workspaceId: 1, role: 1, status: 1 })
      .lean<Pick<IUser, '_id' | 'workspaceId' | 'role' | 'status'>>();
  },

  findById(workspaceId: Types.ObjectId, id: Types.ObjectId | string, session?: ClientSession) {
    return User.findOne({ workspaceId, _id: id }).session(session ?? null).lean<IUser>();
  },

  findByIds(workspaceId: Types.ObjectId, ids: Types.ObjectId[]) {
    return User.find({ workspaceId, _id: { $in: ids } }).lean<IUser[]>();
  },

  listActive(workspaceId: Types.ObjectId, limit: number) {
    return User.find({ workspaceId, status: 'active' }).collation({ locale: 'en', strength: 2 }).sort({ name: 1 }).limit(limit).lean<IUser[]>();
  },

  findByEmail(workspaceId: Types.ObjectId, email: string, session?: ClientSession) {
    return User.findOne({ workspaceId, email }).session(session ?? null).lean<IUser>();
  },

  /** Cross-workspace lookup used only by login, before the tenant is known. */
  findLoginCandidates(email: string) {
    return User.find({ email, status: { $ne: 'invited' } })
      .setOptions({ skipTenant: true })
      .limit(20)
      .lean<IUser[]>();
  },

  async create(doc: Partial<IUser>, session: ClientSession): Promise<IUser> {
    const [created] = await User.create([doc], { session });
    return created!.toObject<IUser>();
  },

  list(workspaceId: Types.ObjectId, q: ListUsersQuery): Promise<Page<IUser>> {
    const filter: FilterQuery<IUser> = { workspaceId };
    if (q.status) filter.status = q.status;
    if (q.q) {
      const rx = new RegExp(`^${escapeRegex(q.q)}`, 'i');
      filter.$or = [{ name: rx }, { email: rx }];
    }
    return paginate(User, { filter, sortField: 'name', direction: 1, limit: q.limit, cursor: q.cursor });
  },

  update(workspaceId: Types.ObjectId, id: Types.ObjectId, expectedVersion: number, set: Partial<IUser>, actorId: Types.ObjectId) {
    return updateVersioned(User, { workspaceId, _id: id }, expectedVersion, { $set: { ...set, updatedBy: actorId } }, 'User');
  },

  /** Field-level update with no version bump: preferences never conflict with profile edits. */
  setEmailPrefs(workspaceId: Types.ObjectId, id: Types.ObjectId, prefs: { [K in 'assigned' | 'testing' | 'dueSoon' | 'mentioned']?: boolean | undefined }) {
    const $set = Object.fromEntries(Object.entries(prefs).filter(([, v]) => v !== undefined).map(([k, v]) => [`notificationPrefs.email.${k}`, v]));
    return User.findOneAndUpdate({ workspaceId, _id: id }, { $set }, { new: true }).lean<IUser>();
  },

  setRole(workspaceId: Types.ObjectId, id: Types.ObjectId, role: Role, actorId: Types.ObjectId) {
    return User.findOneAndUpdate(
      { workspaceId, _id: id },
      { $set: { role, updatedBy: actorId }, $inc: { version: 1 } },
      { new: true },
    ).lean<IUser>();
  },

  setStatus(workspaceId: Types.ObjectId, id: Types.ObjectId, status: UserStatus, actorId: Types.ObjectId) {
    return User.findOneAndUpdate(
      { workspaceId, _id: id },
      { $set: { status, updatedBy: actorId }, $inc: { version: 1 } },
      { new: true },
    ).lean<IUser>();
  },

  /**
   * Atomically counts a failed login and, from the 5th consecutive failure, (re)arms a 15-minute
   * lock flag. The $inc runs server-side, so parallel guesses each see their own count. The flag is
   * a signal only (see authService.login): it never blocks the correct password.
   */
  async recordFailedLogin(user: IUser): Promise<{ failedLoginCount: number; lockedNow: boolean }> {
    const updated = await User.findOneAndUpdate(
      { workspaceId: user.workspaceId, _id: user._id },
      { $inc: { failedLoginCount: 1 } },
      { new: true, projection: { failedLoginCount: 1 } },
    ).lean<Pick<IUser, 'failedLoginCount'>>();
    const failedLoginCount = updated?.failedLoginCount ?? 0;
    const lockedNow = failedLoginCount >= LOCK_THRESHOLD;
    if (lockedNow) {
      await User.updateOne(
        { workspaceId: user.workspaceId, _id: user._id },
        { $set: { lockedUntil: new Date(Date.now() + LOCK_MS) } },
      );
    }
    return { failedLoginCount, lockedNow };
  },

  async recordSuccessfulLogin(user: IUser): Promise<void> {
    await User.updateOne(
      { workspaceId: user.workspaceId, _id: user._id },
      { $set: { failedLoginCount: 0, lockedUntil: null, lastSeenAt: new Date() } },
    );
  },
};
