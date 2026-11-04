import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { ROLES, type Role } from '@teamtrack/shared';
import { env, jwtKeys } from '../config/env';
import { UnauthorizedError } from '../errors/AppError';

const ISSUER = 'teamtrack';
const AUDIENCE = 'teamtrack-web';

export interface AccessClaims {
  sub: string;
  wid: string;
  sid: string;
  role: Role;
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign({ wid: claims.wid, sid: claims.sid, role: claims.role }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    keyid: env.JWT_ACCESS_KID,
    subject: claims.sub,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: env.JWT_ACCESS_TTL_SEC,
  });
}

export function verifyAccessToken(token: string): {
  userId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  sessionId: Types.ObjectId;
  expiresAt: Date;
} {
  const decoded = jwt.decode(token, { complete: true });
  const kid = decoded?.header.kid;
  const secret = kid ? jwtKeys.get(kid) : undefined;
  if (!secret) throw new UnauthorizedError('Invalid access token');

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    }) as jwt.JwtPayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired access token');
  }

  const { sub, wid, sid, role } = payload as Partial<AccessClaims>;
  if (
    !sub || !wid || !sid ||
    !Types.ObjectId.isValid(sub) || !Types.ObjectId.isValid(wid) || !Types.ObjectId.isValid(sid) ||
    !ROLES.includes(role as Role)
  ) {
    throw new UnauthorizedError('Invalid access token');
  }
  return {
    userId: new Types.ObjectId(sub),
    workspaceId: new Types.ObjectId(wid),
    sessionId: new Types.ObjectId(sid),
    expiresAt: new Date((payload.exp ?? 0) * 1000),
  };
}

/** 256-bit random token, URL-safe (43 chars). Only its SHA-256 is ever stored. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
