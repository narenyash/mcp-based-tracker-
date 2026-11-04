import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import { app, bearer, cookieValue, login, PASSWORD, signup, uniqueEmail, useTestDb } from './helpers';
import { Session, User } from '../src/models';
import { sessionRepository } from '../src/repositories/sessionRepository';

useTestDb();

const me = (token: string) => request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);

async function loginRaw(email: string) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  const csrf = cookieValue(res, 'tt_csrf')!;
  return { res, token: res.body.accessToken as string, csrf, cookie: `tt_rt=${cookieValue(res, 'tt_rt')}; tt_csrf=${csrf}` };
}

describe('access tokens follow their session family', () => {
  it('log out everywhere kills outstanding access tokens immediately', async () => {
    const s = await signup();
    const other = await login(s.body.user.email);
    expect((await me(other.token)).status).toBe(200);

    expect((await request(app).post('/api/v1/auth/logout-all').set(bearer(s))).status).toBe(204);
    expect((await me(s.token)).status).toBe(401);
    expect((await me(other.token)).status).toBe(401);
  });

  it('logout kills that device’s access token but not other devices', async () => {
    const s = await signup();
    const device = await loginRaw(s.body.user.email);
    expect((await request(app).post('/api/v1/auth/logout').set('Cookie', device.cookie).set('x-csrf-token', device.csrf)).status).toBe(204);
    expect((await me(device.token)).status).toBe(401);
    expect((await me(s.token)).status).toBe(200);
  });

  it('a normal refresh rotation keeps the earlier access token and the new one working', async () => {
    const s = await signup();
    const device = await loginRaw(s.body.user.email);
    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', device.cookie).set('x-csrf-token', device.csrf);
    expect(refreshed.status).toBe(200);

    expect((await me(device.token)).status).toBe(200);
    expect((await me(refreshed.body.accessToken as string)).status).toBe(200);

    // Logging out with the rotated-to refresh token ends the family, old access token included.
    const csrf2 = cookieValue(refreshed, 'tt_csrf')!;
    const cookie2 = `tt_rt=${cookieValue(refreshed, 'tt_rt')}; tt_csrf=${csrf2}`;
    await request(app).post('/api/v1/auth/logout').set('Cookie', cookie2).set('x-csrf-token', csrf2);
    expect((await me(device.token)).status).toBe(401);
    expect((await me(refreshed.body.accessToken as string)).status).toBe(401);
  });

  it('refresh-token reuse revokes the family, including access tokens already issued', async () => {
    const s = await signup();
    const device = await loginRaw(s.body.user.email);
    const first = await request(app).post('/api/v1/auth/refresh').set('Cookie', device.cookie).set('x-csrf-token', device.csrf);
    expect(first.status).toBe(200);

    await Session.updateMany({ revokedAt: { $ne: null } }, { $set: { revokedAt: new Date(Date.now() - 60_000) } });
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', device.cookie).set('x-csrf-token', device.csrf)).status).toBe(401);

    expect((await me(first.body.accessToken as string)).status).toBe(401);
    expect((await me(device.token)).status).toBe(401);
    expect((await me(s.token)).status).toBe(200);
  });

  it('isSessionActive reports family state and enforces the workspace', async () => {
    const s = await signup();
    const row = await Session.findOne({ userId: s.body.user.id }).lean();
    expect(await sessionRepository.isSessionActive(row!._id, row!.workspaceId)).toBe(true);
    expect(await sessionRepository.isSessionActive(row!._id, new Types.ObjectId())).toBe(false);
    await sessionRepository.revokeFamily(row!.familyId);
    expect(await sessionRepository.isSessionActive(row!._id, row!.workspaceId)).toBe(false);
  });
});

describe('login lockout', () => {
  it('answers a flagged account with the same 401 as any failure, never 423', async () => {
    const email = uniqueEmail();
    await signup({ email });
    await User.updateOne({ email }, { $set: { lockedUntil: new Date(Date.now() + 15 * 60_000), failedLoginCount: 9 } }).setOptions({ skipTenant: true });

    const res = await request(app).post('/api/v1/auth/login').send({ email, password: 'wrong-password-x' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    expect(res.body.detail ?? res.body.title).not.toMatch(/attempt|lock/i);

    const ok = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(ok.status).toBe(200);
    const user = await User.findOne({ email }).setOptions({ skipTenant: true }).lean();
    expect(user?.failedLoginCount).toBe(0);
    expect(user?.lockedUntil).toBeNull();
  });

  it('counts parallel wrong attempts atomically', async () => {
    const email = uniqueEmail();
    await signup({ email });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => request(app).post('/api/v1/auth/login').send({ email, password: 'wrong-password-x' })),
    );
    expect(results.every((r) => r.status === 401)).toBe(true);
    const user = await User.findOne({ email }).setOptions({ skipTenant: true }).lean();
    expect(user?.failedLoginCount).toBe(8);
    expect(user?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
  });
});
