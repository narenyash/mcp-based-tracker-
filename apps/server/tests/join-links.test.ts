import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, bearer, inviteAndAccept, login, PASSWORD, signup, uniqueEmail, useTestDb, type TestSession } from './helpers';
import { Invite, JoinLink, Outbox, User } from '../src/models';

useTestDb();

const generate = (owner: TestSession) => request(app).post('/api/v1/invites/link').set(bearer(owner));
const tokenOf = (url: string) => url.split('/').pop()!;
const join = (token: string, email = uniqueEmail('joiner')) =>
  request(app).post('/api/v1/invites/accept').send({ token, email, name: 'Joiner', password: PASSWORD });

describe('team join links', () => {
  it('stays copyable: the owner gets the same url back, and only a hash is stored', async () => {
    const owner = await signup();
    expect((await request(app).get('/api/v1/invites/link').set(bearer(owner))).body).toBeNull();

    const created = await generate(owner);
    expect(created.status).toBe(201);
    const again = await request(app).get('/api/v1/invites/link').set(bearer(owner));
    expect(again.body.url).toBe(created.body.url);

    const stored = await JoinLink.findOne({ workspaceId: owner.body.workspace.id }).lean();
    expect(stored!.tokenHash).not.toContain(tokenOf(created.body.url));
    expect(JSON.stringify(stored)).not.toContain(tokenOf(created.body.url));
  });

  it('lets several people join as members, who can then log in', async () => {
    const owner = await signup();
    const token = tokenOf((await generate(owner)).body.url);

    const preview = await request(app).get(`/api/v1/invites/${token}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ email: null, role: 'member', workspaceName: owner.body.workspace.name });

    const emails = [uniqueEmail('a'), uniqueEmail('b')];
    for (const email of emails) {
      const res = await join(token, email);
      expect(res.status).toBe(201);
      expect(res.body.user.role).toBe('member');
      expect(res.body.workspace.id).toBe(owner.body.workspace.id);
      expect((await login(email)).body.user.email).toBe(email);
    }
    expect((await request(app).get('/api/v1/invites/link').set(bearer(owner))).body.useCount).toBe(2);
  });

  it('requires an email, and refuses one already in the workspace', async () => {
    const owner = await signup();
    const token = tokenOf((await generate(owner)).body.url);
    const noEmail = await request(app).post('/api/v1/invites/accept').send({ token, name: 'Joiner', password: PASSWORD });
    expect(noEmail.status).toBe(400);
    expect((await join(token, owner.body.user.email)).status).toBe(409);
    expect(await User.countDocuments({ workspaceId: owner.body.workspace.id })).toBe(1);
  });

  it('is owner-only', async () => {
    const owner = await signup();
    for (const role of ['admin', 'manager', 'member']) {
      const person = await inviteAndAccept(owner, role);
      expect((await request(app).get('/api/v1/invites/link').set(bearer(person))).status).toBe(403);
      expect((await generate(person)).status).toBe(403);
      expect((await request(app).delete('/api/v1/invites/link').set(bearer(person))).status).toBe(403);
    }
  });

  it('generating a new link kills the old one; turning it off kills the link', async () => {
    const owner = await signup();
    const first = tokenOf((await generate(owner)).body.url);
    const second = tokenOf((await generate(owner)).body.url);
    expect(second).not.toBe(first);
    expect((await request(app).get(`/api/v1/invites/${first}/preview`)).status).toBe(404);
    expect((await join(first)).status).toBe(404);
    expect((await join(second)).status).toBe(201);

    expect((await request(app).delete('/api/v1/invites/link').set(bearer(owner))).status).toBe(204);
    expect((await join(second)).status).toBe(404);
    expect((await request(app).get('/api/v1/invites/link').set(bearer(owner))).body).toBeNull();
    expect((await generate(owner)).status).toBe(201);
  });

  it('stops working once expired, and a new one can still be generated', async () => {
    const owner = await signup();
    const token = tokenOf((await generate(owner)).body.url);
    await JoinLink.updateOne({ workspaceId: owner.body.workspace.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await join(token)).status).toBe(404);
    expect((await request(app).get('/api/v1/invites/link').set(bearer(owner))).body).toBeNull();
    expect((await generate(owner)).status).toBe(201);
  });

  it('lapses if its creator is no longer an active owner', async () => {
    const owner = await signup();
    const token = tokenOf((await generate(owner)).body.url);
    await User.updateOne({ _id: owner.body.user.id, workspaceId: owner.body.workspace.id }, { $set: { status: 'suspended' } });
    expect((await join(token)).status).toBe(404);
  });

  it('keeps each workspace separate', async () => {
    const a = await signup();
    const b = await signup();
    const tokenA = tokenOf((await generate(a)).body.url);
    expect((await request(app).get('/api/v1/invites/link').set(bearer(b))).body).toBeNull();
    await request(app).delete('/api/v1/invites/link').set(bearer(b));
    const joined = await join(tokenA);
    expect(joined.status).toBe(201);
    expect(joined.body.workspace.id).toBe(a.body.workspace.id);
  });

  it('retires a pending email invite for the same person', async () => {
    const owner = await signup();
    const email = uniqueEmail('both');
    await request(app).post('/api/v1/invites').set(bearer(owner)).send({ email, role: 'admin' });
    const token = tokenOf((await generate(owner)).body.url);
    expect((await join(token, email)).status).toBe(201);
    expect(await Invite.countDocuments({ workspaceId: owner.body.workspace.id, email, revokedAt: null })).toBe(0);
  });

  it('an email invite keeps its own address and role, ignoring any email sent with it', async () => {
    const owner = await signup();
    const email = uniqueEmail('invited');
    const invite = await request(app).post('/api/v1/invites').set(bearer(owner)).send({ email, role: 'manager' });
    const msg = await Outbox.findOne({ dedupeKey: `invite:${invite.body.id}` }).lean();
    const token = tokenOf((msg!.payload as { data: { url: string } }).data.url);

    const res = await join(token, uniqueEmail('someone-else'));
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.role).toBe('manager');
  });
});
