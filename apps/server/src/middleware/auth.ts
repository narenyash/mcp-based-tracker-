import type { RequestHandler } from 'express';
import { hasRoleAtLeast, type Role } from '@teamtrack/shared';
import { verifyAccessToken } from '../auth/tokens';
import { ForbiddenError, UnauthorizedError } from '../errors/AppError';
import { getContext } from '../observability/requestContext';
import { userRepository } from '../repositories/userRepository';
import { sessionRepository } from '../repositories/sessionRepository';
import { requireAuth } from '../auth/context';

/**
 * Verifies the Bearer access token, then re-loads the user and checks its session family so that
 * suspensions, role changes and logouts take effect immediately rather than when the token expires.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) throw new UnauthorizedError();
  const claims = verifyAccessToken(header.slice(7));

  const [user, live] = await Promise.all([
    userRepository.findForAuth(claims.workspaceId, claims.userId),
    sessionRepository.isSessionActive(claims.sessionId, claims.workspaceId),
  ]);
  if (!user || user.status !== 'active' || !live) throw new UnauthorizedError('Session is no longer valid');

  req.auth = { userId: user._id, workspaceId: user.workspaceId, role: user.role, sessionId: claims.sessionId };
  const ctx = getContext();
  if (ctx) {
    ctx.userId = user._id.toHexString();
    ctx.workspaceId = user.workspaceId.toHexString();
  }
  next();
};

export function requireRole(min: Role): RequestHandler {
  return (req, _res, next) => {
    if (!hasRoleAtLeast(requireAuth(req).role, min)) throw new ForbiddenError();
    next();
  };
}
