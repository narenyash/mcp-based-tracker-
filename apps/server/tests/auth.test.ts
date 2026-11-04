import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, bearer, cookieValue, login, PASSWORD, signup, uniqueEmail, useTestDb } from './helpers';
import { Session } from '../src/models';

useTestDb();

describe('signup & login', () => {
  it('creates a workspace with the caller as owner and returns a session', async () => {
    const s = await signup({ workspaceName: 'Sweacher Creations', name: 'Naren' });
    expect(s.body.user.role).toBe('owner');
    expect(s.body.workspace.slug).toBe('sweacher-creations');
    expect(s.csrf).toBeTruthy();

    const me = await request(app).get('/api/v1/auth/me').set(bearer(s));
    expect(me.status).toBe(200);
    expect(me.body.user.name).toBe('Naren');
    expect(me.body.user).not.toHaveProperty('passwordHash');
  });

  it('gives a second workspace with the same name a distinct slug', async () => {
    const a = await signup({ workspaceName: 'Acme' });
    const b = await signup({ workspaceName: 'Acme' });
    expect(a.body.workspace.slug).not.toBe(b.body.workspace.slug);
  });

  it('rejects a wrong password with a generic error', async () => {
    const email = uniqueEmail();
    await signup({ email });
    const res = await request(app).post('/api/v1/auth/login').send({ email, password: 'nope-nope-nope' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('rejects unknown emails with the same error as wrong passwords', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'ghost@example.com', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('never reveals lock state and still accepts the right password after 5 failures', async () => {
    const email = uniqueEmail();
    await signup({ email });
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/v1/auth/login').send({ email, password: 'wrong-password-x' });
    }
    const wrong = await request(app).post('/api/v1/auth/login').send({ email, password: 'wrong-password-x' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');

    const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('asks which workspace when one email/password matches several', async () => {
    const email = uniqueEmail();
    const first = await signup({ email, workspaceName: 'One' });
    await signup({ email, workspaceName: 'Two' });
    const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WORKSPACE_REQUIRED');
    expect(res.body.workspaces).toHaveLength(2);

    const s = await login(email, PASSWORD, first.body.workspace.slug);
    expect(s.body.workspace.id).toBe(first.body.workspace.id);
  });

  it('validates input and reports field errors', async () => {
    const res = await request(app).post('/api/v1/auth/signup').send({ workspaceName: 'A', name: '', email: 'x', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    const paths = (res.body.errors as { path: string }[]).map((e) => e.path).sort();
    expect(paths).toEqual(['email', 'name', 'password', 'workspaceName']);
  });

  it('rejects requests without a valid access token', async () => {
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer garbage')).status).toBe(401);
  });
});

describe('refresh tokens', () => {
  it('rotates the refresh token and issues a new access token', async () => {
    const s = await signup();
    const res = await s.agent.post('/api/v1/auth/refresh').set('x-csrf-token', s.csrf);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(await Session.countDocuments({ revokedAt: null })).toBe(1);
    expect(await Session.countDocuments({ revokedAt: { $ne: null } })).toBe(1);
  });

  it('requires the CSRF header', async () => {
    const s = await signup();
    const res = await s.agent.post('/api/v1/auth/refresh');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_FAILED');
  });

  it('revokes the whole session family when a rotated token is replayed after the grace window', async () => {
    const s = await signup();
    const signupRes = await request(app).post('/api/v1/auth/login').send({ email: s.body.user.email, password: PASSWORD });
    const stolen = cookieValue(signupRes, 'tt_rt')!;
    const csrf = cookieValue(signupRes, 'tt_csrf')!;
    const cookie = `tt_rt=${stolen}; tt_csrf=${csrf}`;

    const first = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).set('x-csrf-token', csrf);
    expect(first.status).toBe(200);

    // Age the rotation past the grace window, then replay the old token.
    await Session.updateMany({ revokedAt: { $ne: null } }, { $set: { revokedAt: new Date(Date.now() - 60_000) } });
    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).set('x-csrf-token', csrf);
    expect(replay.status).toBe(401);

    // The legitimate successor token is now dead too.
    const successor = cookieValue(first, 'tt_rt')!;
    const csrf2 = cookieValue(first, 'tt_csrf')!;
    const after = await request(app).post('/api/v1/auth/refresh').set('Cookie', `tt_rt=${successor}; tt_csrf=${csrf2}`).set('x-csrf-token', csrf2);
    expect(after.status).toBe(401);
  });

  it('logout revokes the session', async () => {
    const s = await signup();
    const res = await request(app).post('/api/v1/auth/login').send({ email: s.body.user.email, password: PASSWORD });
    const csrf = cookieValue(res, 'tt_csrf')!;
    const cookie = `tt_rt=${cookieValue(res, 'tt_rt')}; tt_csrf=${csrf}`;
    expect((await request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('x-csrf-token', csrf)).status).toBe(204);
    // Replaying the logged-out refresh token must fail even with a valid CSRF pair.
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).set('x-csrf-token', csrf)).status).toBe(401);
  });
});
