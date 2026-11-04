import type { Request, Response } from 'express';
import { loginSchema, signupSchema } from '@teamtrack/shared';
import { parse } from '../../middleware/validate';
import { clientMeta, requireAuth } from '../../auth/context';
import { assertCsrf, clearSessionCookies, readRefreshCookie, setSessionCookies } from '../../auth/cookies';
import { UnauthorizedError } from '../../errors/AppError';
import { ERROR_CODES } from '@teamtrack/shared';
import { authService, type IssuedSession } from './auth.service';

export function sendSession(res: Response, issued: IssuedSession, status = 200): void {
  setSessionCookies(res, issued.refreshToken, issued.refreshExpiresAt);
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(issued.body);
}

export const authController = {
  async signup(req: Request, res: Response) {
    const input = parse(signupSchema, req.body);
    sendSession(res, await authService.signup(input, clientMeta(req)), 201);
  },

  async login(req: Request, res: Response) {
    const input = parse(loginSchema, req.body);
    sendSession(res, await authService.login(input, clientMeta(req)));
  },

  async refresh(req: Request, res: Response) {
    assertCsrf(req);
    const token = readRefreshCookie(req);
    if (!token) throw new UnauthorizedError('No session', ERROR_CODES.REFRESH_INVALID);
    try {
      sendSession(res, await authService.refresh(token, clientMeta(req)));
    } catch (err) {
      clearSessionCookies(res);
      throw err;
    }
  },

  async logout(req: Request, res: Response) {
    assertCsrf(req);
    await authService.logout(readRefreshCookie(req));
    clearSessionCookies(res);
    res.status(204).end();
  },

  async logoutAll(req: Request, res: Response) {
    await authService.logoutAll(requireAuth(req));
    clearSessionCookies(res);
    res.status(204).end();
  },

  async me(req: Request, res: Response) {
    res.json(await authService.me(requireAuth(req)));
  },
};
