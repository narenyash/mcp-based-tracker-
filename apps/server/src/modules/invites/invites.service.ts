import { Types, type ClientSession } from 'mongoose';
import {
  assignableRoles,
  hasRoleAtLeast,
  type AcceptInviteInput,
  type CreateInviteInput,
  type InviteDto,
  type InvitePreviewDto,
  type JoinLinkDto,
} from '@teamtrack/shared';
import { env } from '../../config/env';
import { withTransaction } from '../../db/transaction';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors/AppError';
import { hashPassword } from '../../auth/password';
import { deriveJoinLinkToken, generateOpaqueToken, hashToken } from '../../auth/tokens';
import type { AuthContext, ClientMeta } from '../../auth/context';
import { inviteRepository } from '../../repositories/inviteRepository';
import { joinLinkRepository } from '../../repositories/joinLinkRepository';
import type { IJoinLink } from '../../models/JoinLink';
import { userRepository } from '../../repositories/userRepository';
import { workspaceRepository } from '../../repositories/workspaceRepository';
import { memberRepository, projectRepository } from '../../repositories/projectRepository';
import { enqueue } from '../../services/outbox';
import { toInviteDto } from '../dto';
import { authService, type IssuedSession } from '../auth/auth.service';
import { projectsService } from '../projects/projects.service';

const INVITE_TTL_DAYS = 7;
const invalidLink = () => new NotFoundError('Invite');
/** People who join by a shared link are always members; the owner can change their role afterwards. */
const JOIN_LINK_ROLE = 'member' as const;

const toJoinLinkDto = (link: IJoinLink, token: string): JoinLinkDto => ({
  url: `${env.CLIENT_URL}/invite/${token}`,
  expiresAt: link.expiresAt.toISOString(),
  useCount: link.useCount,
});

async function joinViaLink(input: AcceptInviteInput, passwordHash: string, meta: ClientMeta, session: ClientSession): Promise<IssuedSession> {
  const link = await joinLinkRepository.findActiveByTokenHash(hashToken(input.token), session);
  if (!link) throw invalidLink();
  if (!input.email) throw new ValidationError([{ path: 'email', message: 'Email is required' }]);

  const workspace = await workspaceRepository.findById(link.workspaceId, session);
  if (!workspace) throw invalidLink();
  // The link carries its creator's authority: it lapses if they are suspended or no longer the owner.
  const creator = await userRepository.findById(link.workspaceId, link.createdBy, session);
  if (!creator || creator.status !== 'active' || creator.role !== 'owner') throw invalidLink();
  if (await userRepository.findByEmail(link.workspaceId, input.email, session)) {
    throw new ConflictError('An account with this email already exists in the workspace');
  }

  // They are joining another way, so an email invite still pending for them is now moot.
  await inviteRepository.revokePendingForEmail(link.workspaceId, input.email, session);
  const user = await userRepository.create(
    {
      workspaceId: link.workspaceId,
      email: input.email,
      name: input.name,
      role: JOIN_LINK_ROLE,
      status: 'active',
      passwordHash,
      passwordChangedAt: new Date(),
      lastSeenAt: new Date(),
      createdBy: link.createdBy,
    } as Parameters<typeof userRepository.create>[0],
    session,
  );
  await joinLinkRepository.recordUse(link.workspaceId, link._id, session);
  return authService.issueSession(user, workspace, meta, { session });
}

export const invitesService = {
  async create(ctx: AuthContext, input: CreateInviteInput): Promise<InviteDto> {
    if (!assignableRoles(ctx.role).includes(input.role)) {
      throw new ForbiddenError(`You cannot invite someone as ${input.role}`);
    }
    const existing = await userRepository.findByEmail(ctx.workspaceId, input.email);
    if (existing) throw new ConflictError('This person is already in the workspace');

    // Inviting into a project grants membership, so the inviter must be able to manage each one.
    // Unknown, hidden and unmanageable projects fail alike, so ids cannot be probed.
    const projectIds = [...new Set(input.projectIds.map((id) => id.toLowerCase()))].map((id) => new Types.ObjectId(id));
    for (const id of projectIds) {
      const manageable = await projectsService.access(ctx, id).then(
        (a) => a.canManage,
        (err: unknown) => {
          if (err instanceof NotFoundError) return false;
          throw err;
        },
      );
      if (!manageable) throw new ValidationError([{ path: 'projectIds', message: 'One or more projects do not exist or you cannot add people to them' }]);
    }

    const [workspace, inviter] = await Promise.all([
      workspaceRepository.findById(ctx.workspaceId),
      userRepository.findById(ctx.workspaceId, ctx.userId),
    ]);
    if (!workspace || !inviter) throw new NotFoundError('Workspace');

    const token = generateOpaqueToken();
    return withTransaction(async (session) => {
      // Re-inviting replaces any earlier pending invite (and invalidates its link).
      await inviteRepository.revokePendingForEmail(ctx.workspaceId, input.email, session);
      const invite = await inviteRepository.create(
        {
          workspaceId: ctx.workspaceId,
          email: input.email,
          role: input.role,
          projectIds,
          tokenHash: hashToken(token),
          invitedBy: ctx.userId,
          createdBy: ctx.userId,
          expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 3600_000),
        } as Parameters<typeof inviteRepository.create>[0],
        session,
      );
      await enqueue(session, [
        {
          type: 'email.send',
          dedupeKey: `invite:${invite._id.toHexString()}`,
          payload: {
            template: 'invite',
            to: input.email,
            workspaceId: ctx.workspaceId.toHexString(),
            data: {
              inviterName: inviter.name,
              workspaceName: workspace.name,
              role: input.role,
              url: `${env.CLIENT_URL}/invite/${token}`,
              expiresInDays: INVITE_TTL_DAYS,
            },
          },
        },
      ]);
      return toInviteDto(invite);
    });
  },

  async list(ctx: AuthContext): Promise<InviteDto[]> {
    return (await inviteRepository.listPending(ctx.workspaceId)).map(toInviteDto);
  },

  async revoke(ctx: AuthContext, id: string): Promise<void> {
    const revoked = await inviteRepository.revoke(ctx.workspaceId, id);
    if (!revoked) throw new NotFoundError('Invite');
  },

  /** The live join link, or null if there is none (or it can no longer be rebuilt after a secret rotation). */
  async getJoinLink(ctx: AuthContext): Promise<JoinLinkDto | null> {
    const link = await joinLinkRepository.findActive(ctx.workspaceId);
    if (!link) return null;
    const token = deriveJoinLinkToken(link._id);
    return hashToken(token) === link.tokenHash ? toJoinLinkDto(link, token) : null;
  },

  /** Creates the workspace's join link, replacing (and invalidating) any earlier one. */
  async generateJoinLink(ctx: AuthContext): Promise<JoinLinkDto> {
    const id = new Types.ObjectId();
    const token = deriveJoinLinkToken(id);
    return withTransaction(async (session) => {
      await joinLinkRepository.revokeLive(ctx.workspaceId, session);
      const link = await joinLinkRepository.create(
        {
          _id: id,
          workspaceId: ctx.workspaceId,
          tokenHash: hashToken(token),
          createdBy: ctx.userId,
          expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 3600_000),
        },
        session,
      );
      return toJoinLinkDto(link, token);
    });
  },

  async revokeJoinLink(ctx: AuthContext): Promise<void> {
    await joinLinkRepository.revokeLive(ctx.workspaceId);
  },

  async preview(token: string): Promise<InvitePreviewDto> {
    const tokenHash = hashToken(token);
    const invite = await inviteRepository.findPendingByTokenHash(tokenHash);
    if (invite) {
      const workspace = await workspaceRepository.findById(invite.workspaceId);
      if (!workspace) throw invalidLink();
      return { email: invite.email, role: invite.role, workspaceName: workspace.name };
    }
    const link = await joinLinkRepository.findActiveByTokenHash(tokenHash);
    if (!link) throw invalidLink();
    const workspace = await workspaceRepository.findById(link.workspaceId);
    if (!workspace) throw invalidLink();
    return { email: null, role: JOIN_LINK_ROLE, workspaceName: workspace.name };
  },

  async accept(input: AcceptInviteInput, meta: ClientMeta): Promise<IssuedSession> {
    const passwordHash = await hashPassword(input.password);
    return withTransaction(async (session) => {
      const invite = await inviteRepository.findPendingByTokenHash(hashToken(input.token), session);
      if (!invite) return joinViaLink(input, passwordHash, meta, session);
      const claimed = await inviteRepository.markAccepted(invite.workspaceId, invite._id, session);
      if (!claimed) throw invalidLink();

      const workspace = await workspaceRepository.findById(invite.workspaceId, session);
      if (!workspace) throw invalidLink();
      // The invite carries the inviter's authority: it lapses if they were suspended or lost the role.
      const inviter = await userRepository.findById(invite.workspaceId, invite.invitedBy, session);
      if (!inviter || inviter.status !== 'active' || !assignableRoles(inviter.role).includes(invite.role)) throw invalidLink();
      if (await userRepository.findByEmail(invite.workspaceId, invite.email, session)) {
        throw new ConflictError('An account with this email already exists in the workspace');
      }

      const user = await userRepository.create(
        {
          workspaceId: invite.workspaceId,
          email: invite.email,
          name: input.name,
          role: invite.role,
          status: 'active',
          passwordHash,
          passwordChangedAt: new Date(),
          lastSeenAt: new Date(),
          createdBy: invite.invitedBy,
        } as Parameters<typeof userRepository.create>[0],
        session,
      );

      for (const projectId of invite.projectIds) {
        const project = await projectRepository.findById(invite.workspaceId, projectId, session);
        if (!project) continue; // project deleted since the invite was sent
        if (!hasRoleAtLeast(inviter.role, 'admin') && (await memberRepository.find(invite.workspaceId, projectId, inviter._id, session))?.role !== 'lead') {
          continue; // the inviter no longer leads it
        }
        await memberRepository.add(
          { workspaceId: invite.workspaceId, projectId, userId: user._id, role: 'member', createdBy: invite.invitedBy },
          session,
        );
        await projectRepository.incrementMemberCount(invite.workspaceId, projectId, 1, session);
      }

      return authService.issueSession(user, workspace, meta, { session });
    });
  },
};
