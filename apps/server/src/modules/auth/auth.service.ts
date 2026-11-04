import { Types, type ClientSession } from 'mongoose';
import {
  ERROR_CODES,
  type LoginInput,
  type SessionResponse,
  type SignupInput,
} from '@teamtrack/shared';
import { env } from '../../config/env';
import { withTransaction } from '../../db/transaction';
import { AppError, ConflictError, ForbiddenError, UnauthorizedError } from '../../errors/AppError';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../../auth/password';
import { generateOpaqueToken, hashToken, signAccessToken } from '../../auth/tokens';
import { refreshTtlMs } from '../../auth/cookies';
import type { AuthContext, ClientMeta } from '../../auth/context';
import type { IUser } from '../../models/User';
import type { IWorkspace } from '../../models/Workspace';
import { userRepository } from '../../repositories/userRepository';
import { workspaceRepository } from '../../repositories/workspaceRepository';
import { sessionRepository } from '../../repositories/sessionRepository';
import { logger } from '../../observability/logger';
import { toUserDto, toWorkspaceDto } from '../dto';
import { realtime } from '../../services/realtime';

/** Window in which a just-rotated refresh token is treated as a benign race (two tabs), not theft. */
const ROTATION_GRACE_MS = 30_000;

export interface IssuedSession {
  body: SessionResponse;
  refreshToken: string;
  refreshExpiresAt: Date;
}

async function issueSession(
  user: IUser,
  workspace: IWorkspace,
  meta: ClientMeta,
  opts: { familyId?: Types.ObjectId; session?: ClientSession } = {},
): Promise<IssuedSession & { sessionId: Types.ObjectId }> {
  const refreshToken = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + refreshTtlMs());
  const sessionId = new Types.ObjectId();
  await sessionRepository.create(
    {
      _id: sessionId,
      workspaceId: user.workspaceId,
      userId: user._id,
      familyId: opts.familyId ?? new Types.ObjectId(),
      tokenHash: hashToken(refreshToken),
      userAgent: meta.userAgent,
      ip: meta.ip,
      expiresAt,
    },
    opts.session,
  );
  const accessToken = signAccessToken({
    sub: user._id.toHexString(),
    wid: user.workspaceId.toHexString(),
    sid: sessionId.toHexString(),
    role: user.role,
  });
  return {
    sessionId,
    refreshToken,
    refreshExpiresAt: expiresAt,
    body: {
      accessToken,
      expiresIn: env.JWT_ACCESS_TTL_SEC,
      user: toUserDto(user),
      workspace: toWorkspaceDto(workspace),
    },
  };
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace'
  );
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  if (!(await workspaceRepository.slugExists(base))) return base;
  for (let i = 0; i < 5; i++) {
    const candidate = `${base}-${generateOpaqueToken().slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    if (!(await workspaceRepository.slugExists(candidate))) return candidate;
  }
  throw new ConflictError('Could not allocate a workspace URL, try another name');
}

export const authService = {
  issueSession,

  async signup(input: SignupInput, meta: ClientMeta): Promise<IssuedSession> {
    if (!env.ALLOW_WORKSPACE_SIGNUP) throw new ForbiddenError('Workspace sign-up is disabled');
    const slug = await uniqueSlug(input.workspaceName);
    const passwordHash = await hashPassword(input.password);

    return withTransaction(async (session) => {
      const workspace = await workspaceRepository.create({ name: input.workspaceName, slug }, session);
      const user = await userRepository.create(
        {
          workspaceId: workspace._id,
          email: input.email,
          name: input.name,
          role: 'owner',
          status: 'active',
          passwordHash,
          passwordChangedAt: new Date(),
          lastSeenAt: new Date(),
        },
        session,
      );
      await workspaceRepository.setOwner(workspace._id, user._id, session);
      return issueSession(user, workspace, meta, { session });
    });
  },

  /**
   * Email + password login. An email may belong to several workspaces; the password is checked
   * against each, and only if more than one matches does the client need to pick a workspace.
   */
  async login(input: LoginInput, meta: ClientMeta): Promise<IssuedSession> {
    let candidates = await userRepository.findLoginCandidates(input.email);
    if (input.workspace) {
      const ws = await workspaceRepository.findBySlug(input.workspace);
      candidates = ws ? candidates.filter((u) => u.workspaceId.equals(ws._id)) : [];
    }
    if (candidates.length === 0) {
      await verifyAgainstDummy(input.password);
      throw new UnauthorizedError('Incorrect email or password', ERROR_CODES.INVALID_CREDENTIALS);
    }

    // Lockout must not become a DoS or an oracle. Brute force is throttled per IP+email and per IP by
    // loginLimiter; the per-account counter only flags an account under attack (for alerting). A
    // flagged account still accepts the correct password, and every failure, flagged or not, gets
    // the same 401 after a real password check, so lock state is never observable.
    const matched: IUser[] = [];
    for (const user of candidates) {
      if (user.passwordHash && (await verifyPassword(user.passwordHash, input.password))) {
        matched.push(user);
      } else {
        const { failedLoginCount, lockedNow } = await userRepository.recordFailedLogin(user);
        if (lockedNow) logger.warn({ userId: user._id.toHexString(), failedLoginCount }, 'repeated failed logins for account');
      }
    }

    if (matched.length === 0) {
      throw new UnauthorizedError('Incorrect email or password', ERROR_CODES.INVALID_CREDENTIALS);
    }

    if (matched.length > 1) {
      const workspaces = await workspaceRepository.findByIds(matched.map((u) => u.workspaceId));
      throw new AppError(409, ERROR_CODES.WORKSPACE_REQUIRED, 'Choose a workspace', {
        workspaces: workspaces.map((w) => ({ slug: w.slug, name: w.name })),
      });
    }

    const user = matched[0]!;
    if (user.status === 'suspended') {
      throw new ForbiddenError('Your account has been suspended', ERROR_CODES.ACCOUNT_SUSPENDED);
    }
    const workspace = await workspaceRepository.findById(user.workspaceId);
    if (!workspace) throw new UnauthorizedError('Incorrect email or password', ERROR_CODES.INVALID_CREDENTIALS);

    await userRepository.recordSuccessfulLogin(user);
    return issueSession(user, workspace, meta);
  },

  /** Rotates the refresh token. Presenting an already-rotated token revokes the whole family. */
  async refresh(rawToken: string, meta: ClientMeta): Promise<IssuedSession> {
    const invalid = () => new UnauthorizedError('Session expired, please sign in again', ERROR_CODES.REFRESH_INVALID);
    const current = await sessionRepository.findByTokenHash(hashToken(rawToken));
    if (!current) throw invalid();

    if (current.revokedAt) {
      const benignRace = current.replacedBy && Date.now() - current.revokedAt.getTime() < ROTATION_GRACE_MS;
      if (!benignRace) {
        logger.warn({ familyId: current.familyId.toHexString(), userId: current.userId.toHexString() }, 'refresh token reuse detected; revoking family');
        await sessionRepository.revokeFamily(current.familyId);
      }
      throw invalid();
    }
    if (current.expiresAt.getTime() <= Date.now()) throw invalid();

    const [user, workspace] = await Promise.all([
      userRepository.findById(current.workspaceId, current.userId),
      workspaceRepository.findById(current.workspaceId),
    ]);
    if (!user || user.status !== 'active' || !workspace) {
      await sessionRepository.revokeFamily(current.familyId);
      throw invalid();
    }

    return withTransaction(async (session) => {
      const issued = await issueSession(user, workspace, meta, { familyId: current.familyId, session });
      const rotated = await sessionRepository.markRotated(current._id, issued.sessionId, session);
      if (!rotated) throw invalid(); // a concurrent refresh won; abort so no orphan session is created
      return issued;
    });
  },

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const current = await sessionRepository.findByTokenHash(hashToken(rawToken));
    if (current) await sessionRepository.revoke(current._id);
  },

  async logoutAll(ctx: AuthContext): Promise<void> {
    await sessionRepository.revokeAllForUser(ctx.userId);
    realtime.disconnectUser(ctx.userId.toHexString());
  },

  async me(ctx: AuthContext) {
    const [user, workspace] = await Promise.all([
      userRepository.findById(ctx.workspaceId, ctx.userId),
      workspaceRepository.findById(ctx.workspaceId),
    ]);
    if (!user || !workspace) throw new UnauthorizedError();
    return { user: toUserDto(user), workspace: toWorkspaceDto(workspace) };
  },
};
