import type { CookieOptions, Request, Response } from 'express';
import { env, isProd } from '../config/env';
import { ERROR_CODES } from '@teamtrack/shared';
import { ForbiddenError } from '../errors/AppError';
import { generateOpaqueToken, safeEqual } from './tokens';

export const REFRESH_COOKIE = 'tt_rt';
export const CSRF_COOKIE = 'tt_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const REFRESH_PATH = '/api/v1/auth';

function base(): CookieOptions {
  return { secure: isProd, sameSite: 'strict' };
}

export function setSessionCookies(res: Response, refreshToken: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, refreshToken, { ...base(), httpOnly: true, path: REFRESH_PATH, expires: expiresAt });
  // Double-submit CSRF token: readable by our JS, echoed back in a header on cookie-authenticated calls.
  res.cookie(CSRF_COOKIE, generateOpaqueToken(), { ...base(), httpOnly: false, path: '/', expires: expiresAt });
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { ...base(), httpOnly: true, path: REFRESH_PATH });
  res.clearCookie(CSRF_COOKIE, { ...base(), path: '/' });
}

export function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Required on every endpoint authenticated by the refresh cookie (refresh, logout). */
export function assertCsrf(req: Request): void {
  const cookie: unknown = req.cookies?.[CSRF_COOKIE];
  const header = req.get(CSRF_HEADER);
  if (typeof cookie !== 'string' || !header || !safeEqual(cookie, header)) {
    throw new ForbiddenError('CSRF token missing or invalid', ERROR_CODES.CSRF_FAILED);
  }
}

export const refreshTtlMs = (): number => env.REFRESH_TTL_DAYS * 24 * 3600 * 1000;
