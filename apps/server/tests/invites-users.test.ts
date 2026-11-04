import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, bearer, inviteAndAccept, login, PASSWORD, signup, uniqueEmail, useTestDb } from './helpers';
import { Outbox, Session } from '../src/models';
import { processOne } from '../src/workers/outboxWorker';
import { EmailLog } from '../src/models';

useTestDb();

describe('invites', () => {
  it('queues an invite email in the outbox and the worker sends it', async () => {
    const owner = await signup();
    const email = uniqueEmail('invitee');
    const res = await request(app).post('/api/v1/invites').set(bearer(owner)).send({ email, role: 'member' });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('tokenHash');

    expect(await Outbox.countDocuments({ status: 'pending' })).toBe(1);
    expect(await processOne()).toBe(true);
    expect(await Outbox.countDocuments({ status: 'done' })).toBe(1);
    const log = await EmailLog.findOne({ to: email }).lean();
    expect(log?.status).toBe('sent');
    expect(log?.subject).toContain('invited you');
  });

  it('accepting creates an active user who can then log in', async () => {
    const owner = await signup();
    const email = uniqueEmail('m');
    const member = await inviteAndAccept(owner, 'member', email);
    expect(member.body.user.role).toBe('member');
    expect(member.body.workspace.id).toBe(owner.body.workspace.id);
    const again = await login(email);
    expect(again.body.user.id).toBe(member.body.user.id);
  });

  it('an invite link works only once', async () => {
    const owner = await signup();
    const inv = await request(app).post('/api/v1/invites').set(bearer(owner)).send({ email: uniqueEmail(), role: 'member' });
    const msg = await Outbox.findOne({ dedupeKey: `invite:${inv.body.id}` }).lean();
    const token = (msg!.payload as { data: { url: string } }).data.url.split('/').pop()!;

    expect((await request(app).get(`/api/v1/invites/${token}/preview`)).status).toBe(200);
    const first = await request(app).post('/api/v1/invites/accept').send({ token, name: 'A', password: PASSWORD });
    expect(first.status).toBe(201);
    const second = await request(app).post('/api/v1/invites/accept').send({ token, name: 'B', password: PASSWORD });
    expect(second.status).toBe(404);
  });

  it('re-inviting the same email invalidates the earlier link', async () => {
    const owner = await signup();
    const email = uniqueEmail();
    const a = await request(app).post('/api/v1/invites').set(bearer(owner)).send({ email, role: 'member' });
    const b = await request(app).post('/api/v1/invites').set(bearer(owner)).send({ email, role: 'manager' });
    expect(b.status).toBe(201);
    const list = await request(app).get('/api/v1/invites').set(bearer(owner));
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([b.body.id]);
    expect(a.body.id).not.toBe(b.body.id);
  });

  it('enforces who may grant which role', async () => {
    const owner = await signup();
    const manager = await inviteAndAccept(owner, 'manager');
    const member = await inviteAndAccept(owner, 'member');

    expect((await request(app).post('/api/v1/invites').set(bearer(manager)).send({ email: uniqueEmail(), role: 'admin' })).status).toBe(403);
    expect((await request(app).post('/api/v1/invites').set(bearer(manager)).send({ email: uniqueEmail(), role: 'member' })).status).toBe(201);
    expect((await request(app).post('/api/v1/invites').set(bearer(member)).send({ email: uniqueEmail(), role: 'guest' })).status).toBe(403);
    expect((await request(app).post('/api/v1/invites').set(bearer(owner)).send({ email: uniqueEmail(), role: 'owner' })).status).toBe(400);
  });

  it('cannot invite someone already in the workspace', async () => {
    const owner = await signup();
    const res = await request(app).post('/api/v1/invites').set(bearer(owner)).send({ email: owner.body.user.email, role: 'member' });
    expect(res.status).toBe(409);
  });
});

describe('users', () => {
  it('lists users with cursor pagination and prefix search', async () => {
    const owner = await signup({ name: 'Zed Owner' });
    for (const name of ['alice', 'bob', 'carol']) await inviteAndAccept(owner, 'member', `${name}@example.com`);

    const p1 = await request(app).get('/api/v1/users?limit=2').set(bearer(owner));
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await request(app).get(`/api/v1/users?limit=2&cursor=${p1.body.nextCursor}`).set(bearer(owner));
    expect(p2.body.items).toHaveLength(2);
    expect(p2.body.nextCursor).toBeNull();
    const all = [...p1.body.items, ...p2.body.items].map((u: { email: string }) => u.email);
    expect(new Set(all).size).toBe(4);

    const search = await request(app).get('/api/v1/users?q=car').set(bearer(owner));
    expect(search.body.items.map((u: { email: string }) => u.email)).toEqual(['carol@example.com']);
  });

  it('updating your profile requires the current version (If-Match)', async () => {
    const owner = await signup();
    const v = owner.body.user.version;
    expect((await request(app).patch('/api/v1/users/me').set(bearer(owner)).send({ name: 'New' })).status).toBe(428);
    const ok = await request(app).patch('/api/v1/users/me').set(bearer(owner)).set('If-Match', `"${v}"`).send({ name: 'New' });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(v + 1);
    const stale = await request(app).patch('/api/v1/users/me').set(bearer(owner)).set('If-Match', `"${v}"`).send({ name: 'Newer' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
  });

  it('suspending a user kills their sessions and access immediately', async () => {
    const owner = await signup();
    const member = await inviteAndAccept(owner, 'member');
    const res = await request(app).patch(`/api/v1/users/${member.body.user.id}/status`).set(bearer(owner)).send({ status: 'suspended' });
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me').set(bearer(member))).status).toBe(401);
    expect(await Session.countDocuments({ userId: member.body.user.id, revokedAt: null })).toBe(0);
  });

  it('admins cannot change the owner or peers, and nobody can change themselves', async () => {
    const owner = await signup();
    const admin = await inviteAndAccept(owner, 'admin');
    const admin2 = await inviteAndAccept(owner, 'admin');
    expect((await request(app).patch(`/api/v1/users/${owner.body.user.id}/role`).set(bearer(admin)).send({ role: 'member' })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/users/${admin2.body.user.id}/role`).set(bearer(admin)).send({ role: 'member' })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/users/${admin.body.user.id}/role`).set(bearer(admin)).send({ role: 'manager' })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/users/${admin.body.user.id}/role`).set(bearer(owner)).send({ role: 'manager' })).status).toBe(200);
  });
});
