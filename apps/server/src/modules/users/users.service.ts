import { Types } from 'mongoose';
import {
  assignableRoles,
  outranks,
  type ListUsersQuery,
  type Page,
  type Role,
  type NotificationPrefsDto,
  type UpdateMeInput,
  type UpdatePreferencesInput,
  type UserDto,
} from '@teamtrack/shared';
import { ForbiddenError, NotFoundError } from '../../errors/AppError';
import type { AuthContext } from '../../auth/context';
import type { IUser } from '../../models/User';
import { userRepository } from '../../repositories/userRepository';
import { sessionRepository } from '../../repositories/sessionRepository';
import { toNotificationPrefsDto, toUserDto } from '../dto';
import { peerIdsOf } from '../projects/projects.service';
import { peerDirectory } from './users.repository';
import { realtime } from '../../services/realtime';

/** Loads a target user and checks the actor may manage them (not self, not the owner, strictly higher role). */
async function loadManageable(ctx: AuthContext, id: string): Promise<IUser> {
  const target = await userRepository.findById(ctx.workspaceId, id);
  if (!target) throw new NotFoundError('User');
  if (target._id.equals(ctx.userId)) throw new ForbiddenError('You cannot change your own role or status');
  if (target.role === 'owner' || !outranks(ctx.role, target.role)) {
    throw new ForbiddenError('You cannot manage someone with an equal or higher role');
  }
  return target;
}

export const usersService = {
  /** Guests only see people who share a project with them; everyone else sees the whole directory. */
  async list(ctx: AuthContext, q: ListUsersQuery): Promise<Page<UserDto>> {
    const peers = await peerIdsOf(ctx);
    const page = peers ? await peerDirectory.list(ctx.workspaceId, q, peers) : await userRepository.list(ctx.workspaceId, q);
    return { items: page.items.map(toUserDto), nextCursor: page.nextCursor };
  },

  async get(ctx: AuthContext, id: string): Promise<UserDto> {
    const user = await userRepository.findById(ctx.workspaceId, id);
    if (!user) throw new NotFoundError('User');
    const peers = await peerIdsOf(ctx);
    if (peers && !peers.some((p) => p.equals(user._id))) throw new NotFoundError('User');
    return toUserDto(user);
  },

  async updateMe(ctx: AuthContext, input: UpdateMeInput, expectedVersion: number): Promise<UserDto> {
    return toUserDto(await userRepository.update(ctx.workspaceId, ctx.userId, expectedVersion, input, ctx.userId));
  },

  async preferences(ctx: AuthContext): Promise<NotificationPrefsDto> {
    const user = await userRepository.findById(ctx.workspaceId, ctx.userId);
    if (!user) throw new NotFoundError('User');
    return toNotificationPrefsDto(user);
  },

  async updatePreferences(ctx: AuthContext, input: UpdatePreferencesInput): Promise<NotificationPrefsDto> {
    const user = await userRepository.setEmailPrefs(ctx.workspaceId, ctx.userId, input.email);
    if (!user) throw new NotFoundError('User');
    return toNotificationPrefsDto(user);
  },

  async changeRole(ctx: AuthContext, id: string, role: Role): Promise<UserDto> {
    await loadManageable(ctx, id);
    if (!assignableRoles(ctx.role).includes(role)) throw new ForbiddenError(`You cannot assign the ${role} role`);
    const updated = await userRepository.setRole(ctx.workspaceId, new Types.ObjectId(id), role, ctx.userId);
    if (!updated) throw new NotFoundError('User');
    return toUserDto(updated);
  },

  async changeStatus(ctx: AuthContext, id: string, status: 'active' | 'suspended'): Promise<UserDto> {
    const target = await loadManageable(ctx, id);
    const updated = await userRepository.setStatus(ctx.workspaceId, target._id, status, ctx.userId);
    if (!updated) throw new NotFoundError('User');
    // Suspension takes effect immediately: access tokens are re-checked per request, sessions are killed here.
    if (status === 'suspended') {
      await sessionRepository.revokeAllForUser(target._id);
      realtime.disconnectUser(target._id.toHexString());
    }
    return toUserDto(updated);
  },
};
