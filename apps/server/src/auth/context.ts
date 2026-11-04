import type { Types } from 'mongoose';
import type { Role } from '@teamtrack/shared';
import { UnauthorizedError } from '../errors/AppError';
import type { Request } from 'express';

/** Identity of the caller, resolved from the access token and re-validated against the DB. */
export interface AuthContext {
  userId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  role: Role;
  sessionId: Types.ObjectId;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      requestId: string;
    }
  }
}

export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw new UnauthorizedError();
  return req.auth;
}

export interface ClientMeta {
  ip: string;
  userAgent: string;
}

export function clientMeta(req: Request): ClientMeta {
  return { ip: (req.ip ?? '').slice(0, 64), userAgent: (req.get('user-agent') ?? '').slice(0, 512) };
}
