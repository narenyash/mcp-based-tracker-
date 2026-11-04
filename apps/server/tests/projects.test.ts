import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, bearer, inviteAndAccept, signup, useTestDb, type TestSession } from './helpers';

useTestDb();

const create = (s: TestSession, body: Record<string, unknown>) =>
  request(app).post('/api/v1/projects').set(bearer(s)).send(body);

describe('projects', () => {
  it('creates a project with default workflow and the creator as lead', async () => {
    const owner = await signup();
    const res = await create(owner, { key: 'web', name: 'Website' });
    expect(res.status).toBe(201);
    expect(res.body.key).toBe('WEB');
    expect(res.body.myRole).toBe('lead');
    expect(res.body.memberCount).toBe(1);
    expect(res.body.workflow.taskStatuses.map((s: { id: string }) => s.id)).toEqual(['todo', 'in_progress', 'review', 'testing', 'done']);
    expect(res.headers.etag).toBe(`"${res.body.version}"`);
  });

  it('rejects a duplicate key case-insensitively, but allows reuse after deletion', async () => {
    const owner = await signup();
    const first = await create(owner, { key: 'APP', name: 'App' });
    const dup = await create(owner, { key: 'app', name: 'Another' });
    expect(dup.status).toBe(409);

    expect((await request(app).delete(`/api/v1/projects/${first.body.id}`).set(bearer(owner))).status).toBe(204);
    expect((await request(app).get(`/api/v1/projects/${first.body.id}`).set(bearer(owner))).status).toBe(404);
    expect((await create(owner, { key: 'APP', name: 'App v2' })).status).toBe(201);
  });

  it('the same key is fine in a different workspace', async () => {
    const a = await signup();
    const b = await signup();
    expect((await create(a, { key: 'OPS', name: 'Ops' })).status).toBe(201);
    expect((await create(b, { key: 'OPS', name: 'Ops' })).status).toBe(201);
  });

  it('members cannot create projects; managers can', async () => {
    const owner = await signup();
    const member = await inviteAndAccept(owner, 'member');
    const manager = await inviteAndAccept(owner, 'manager');
    expect((await create(member, { key: 'NOPE', name: 'Nope' })).status).toBe(403);
    expect((await create(manager, { key: 'YES', name: 'Yes' })).status).toBe(201);
  });

  it('updates use optimistic concurrency', async () => {
    const owner = await signup();
    const p = (await create(owner, { key: 'CC', name: 'Concurrency' })).body;
    const url = `/api/v1/projects/${p.id}`;
    const a = await request(app).patch(url).set(bearer(owner)).set('If-Match', `"${p.version}"`).send({ name: 'Edit A' });
    const b = await request(app).patch(url).set(bearer(owner)).set('If-Match', `"${p.version}"`).send({ name: 'Edit B' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(409);
    expect((await request(app).get(url).set(bearer(owner))).body.name).toBe('Edit A');
  });

  it('private projects are invisible (404) to non-members; workspace projects are visible', async () => {
    const owner = await signup();
    const member = await inviteAndAccept(owner, 'member');
    const priv = (await create(owner, { key: 'SEC', name: 'Secret', visibility: 'private' })).body;
    const pub = (await create(owner, { key: 'PUB', name: 'Public' })).body;

    expect((await request(app).get(`/api/v1/projects/${priv.id}`).set(bearer(member))).status).toBe(404);
    const list = await request(app).get('/api/v1/projects').set(bearer(member));
    expect(list.body.items.map((p: { key: string }) => p.key)).toEqual(['PUB']);

    await request(app).post(`/api/v1/projects/${priv.id}/members`).set(bearer(owner)).send({ userId: member.body.user.id });
    const after = await request(app).get('/api/v1/projects').set(bearer(member));
    expect(after.body.items.map((p: { key: string }) => p.key).sort()).toEqual(['PUB', 'SEC']);
    expect(pub.id).toBeTruthy();
  });

  it('guests only see projects they were added to', async () => {
    const owner = await signup();
    const guest = await inviteAndAccept(owner, 'guest');
    await create(owner, { key: 'AAA', name: 'Alpha' });
    const b = (await create(owner, { key: 'BBB', name: 'Beta' })).body;
    await request(app).post(`/api/v1/projects/${b.id}/members`).set(bearer(owner)).send({ userId: guest.body.user.id, role: 'viewer' });
    const list = await request(app).get('/api/v1/projects').set(bearer(guest));
    expect(list.body.items.map((p: { key: string }) => p.key)).toEqual(['BBB']);
  });

  it('manages members and keeps memberCount consistent; the last lead cannot leave', async () => {
    const owner = await signup();
    const member = await inviteAndAccept(owner, 'member');
    const p = (await create(owner, { key: 'TEAM', name: 'Team' })).body;
    const base = `/api/v1/projects/${p.id}/members`;

    expect((await request(app).post(base).set(bearer(owner)).send({ userId: member.body.user.id })).status).toBe(204);
    expect((await request(app).post(base).set(bearer(owner)).send({ userId: member.body.user.id })).status).toBe(409);
    expect((await request(app).get(`/api/v1/projects/${p.id}`).set(bearer(owner))).body.memberCount).toBe(2);

    // Members cannot manage membership.
    expect((await request(app).delete(`${base}/${owner.body.user.id}`).set(bearer(member))).status).toBe(403);
    // The only lead cannot be demoted or removed.
    expect((await request(app).patch(`${base}/${owner.body.user.id}`).set(bearer(owner)).send({ role: 'member' })).status).toBe(409);
    expect((await request(app).delete(`${base}/${owner.body.user.id}`).set(bearer(owner))).status).toBe(409);
    // Members may leave on their own.
    expect((await request(app).delete(`${base}/${member.body.user.id}`).set(bearer(member))).status).toBe(204);
    expect((await request(app).get(`/api/v1/projects/${p.id}`).set(bearer(owner))).body.memberCount).toBe(1);
  });

  it('a user from another workspace cannot see or touch the project', async () => {
    const a = await signup();
    const b = await signup();
    const p = (await create(a, { key: 'ISO', name: 'Isolated' })).body;
    expect((await request(app).get(`/api/v1/projects/${p.id}`).set(bearer(b))).status).toBe(404);
    expect((await request(app).patch(`/api/v1/projects/${p.id}`).set(bearer(b)).set('If-Match', '"0"').send({ name: 'Hijacked' })).status).toBe(404);
    expect((await request(app).get('/api/v1/projects').set(bearer(b))).body.items).toHaveLength(0);
  });
});
