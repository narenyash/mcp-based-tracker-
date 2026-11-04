import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import type { ProjectDto, SearchResponseDto, StandupFeedDto, TaskDto } from '@teamtrack/shared';
import { app, bearer, inviteAndAccept, PASSWORD, signup, uniqueEmail, useTestDb, type TestSession } from './helpers';
import { Outbox } from '../src/models';

useTestDb();

const base = '/api/v1';
const get = (s: TestSession, url: string) => request(app).get(base + url).set(bearer(s));
const post = (s: TestSession, url: string, body: object = {}) => request(app).post(base + url).set(bearer(s)).send(body);
const patchUrl = (s: TestSession, url: string, body: object) => request(app).patch(base + url).set(bearer(s)).send(body);
const id = (s: TestSession) => s.body.user.id;

async function project(s: TestSession, key: string, visibility: 'workspace' | 'private' = 'workspace'): Promise<ProjectDto> {
  const res = await post(s, '/projects', { key, name: key, visibility });
  if (res.status !== 201) throw new Error(`project failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as ProjectDto;
}

/** Sends an invite and returns its accept token (without accepting). */
async function invite(s: TestSession, body: object): Promise<{ res: request.Response; token?: string }> {
  const res = await post(s, '/invites', { email: uniqueEmail(), role: 'member', ...body });
  if (res.status !== 201) return { res };
  const msg = await Outbox.findOne({ dedupeKey: `invite:${res.body.id}` }).lean();
  return { res, token: (msg!.payload as { data: { url: string } }).data.url.split('/').pop()! };
}
const accept = (token: string) => request(app).post(`${base}/invites/accept`).send({ token, name: 'Invitee', password: PASSWORD });

describe('invites into projects', () => {
  it('only lets the inviter add people to projects they manage, without revealing which ids exist', async () => {
    const owner = await signup();
    const manager = await inviteAndAccept(owner, 'manager');
    const secret = await project(owner, 'SEC', 'private');
    const open = await project(owner, 'OPEN');
    const mine = await project(manager, 'MINE');

    const hidden = await invite(manager, { projectIds: [secret.id] });
    const visibleNotLead = await invite(manager, { projectIds: [open.id] });
    const unknown = await invite(manager, { projectIds: [new Types.ObjectId().toHexString()] });
    for (const { res } of [hidden, visibleNotLead, unknown]) {
      expect(res.status).toBe(400);
      expect(res.body.errors).toEqual(hidden.res.body.errors);
    }

    const ok = await invite(manager, { projectIds: [mine.id] });
    expect(ok.res.status).toBe(201);
    const joined = await accept(ok.token!);
    expect(joined.status).toBe(201);
    const members = (await get(manager, `/projects/${mine.id}/members`)).body.items as { userId: string }[];
    expect(members.map((m) => m.userId)).toContain(joined.body.user.id);

    // Admins may invite into any project.
    expect((await invite(owner, { projectIds: [secret.id, mine.id] })).res.status).toBe(201);
  });

  it('re-checks the inviter when the invite is accepted', async () => {
    const owner = await signup();
    const manager = await inviteAndAccept(owner, 'manager');
    const mine = await project(manager, 'MINE');
    await post(manager, `/projects/${mine.id}/members`, { userId: id(owner), role: 'lead' });

    const stale = await invite(manager, { projectIds: [mine.id] });
    expect((await patchUrl(owner, `/projects/${mine.id}/members/${id(manager)}`, { role: 'member' })).status).toBeLessThan(300);
    const joined = await accept(stale.token!);
    expect(joined.status).toBe(201);
    const members = (await get(owner, `/projects/${mine.id}/members`)).body.items as { userId: string }[];
    expect(members.map((m) => m.userId)).not.toContain(joined.body.user.id);

    const lapsed = await invite(manager, {});
    expect((await patchUrl(owner, `/users/${id(manager)}/status`, { status: 'suspended' })).status).toBe(200);
    expect((await accept(lapsed.token!)).status).toBe(404);
  });
});

describe('testing sign-off', () => {
  it('only the tester or a lead can change the tester while a task is in testing', async () => {
    const owner = await signup();
    const [dev, qa, other] = [await inviteAndAccept(owner, 'member'), await inviteAndAccept(owner, 'member'), await inviteAndAccept(owner, 'member')];
    const web = await project(owner, 'WEB');
    for (const s of [dev, qa, other]) await post(owner, `/projects/${web.id}/members`, { userId: id(s), role: 'member' });
    const t = (await post(owner, `/projects/${web.id}/tasks`, { title: 'Checkout', assigneeId: id(dev), statusId: 'in_progress' })).body as TaskDto;

    const patch = (s: TestSession, task: TaskDto, body: object) =>
      request(app).patch(`${base}/tasks/${task.id}`).set(bearer(s)).set('If-Match', `"${task.version}"`).send(body);
    const move = (s: TestSession, task: TaskDto, body: object) =>
      request(app).patch(`${base}/tasks/${task.id}/move`).set(bearer(s)).set('If-Match', `"${task.version}"`).send(body);

    // A member may still pick the tester when sending work to testing.
    const inTest = (await move(other, t, { statusId: 'testing', testerId: id(qa) })).body as TaskDto;
    expect(inTest.tester?.id).toBe(id(qa));

    expect((await patch(other, inTest, { testerId: id(other) })).status).toBe(403);
    expect((await move(other, inTest, { statusId: 'done' })).status).toBe(403);

    const handedOff = await patch(qa, inTest, { testerId: id(other) });
    expect(handedOff.status).toBe(200);
    expect((await patch(owner, handedOff.body, { testerId: id(qa) })).status).toBe(200);
  });
});

describe('project members', () => {
  it('a guest cannot be promoted to lead', async () => {
    const owner = await signup();
    const guest = await inviteAndAccept(owner, 'guest');
    const web = await project(owner, 'WEB');
    await post(owner, `/projects/${web.id}/members`, { userId: id(guest), role: 'member' });
    const res = await patchUrl(owner, `/projects/${web.id}/members/${id(guest)}`, { role: 'lead' });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].path).toBe('role');
    expect((await patchUrl(owner, `/projects/${web.id}/members/${id(guest)}`, { role: 'viewer' })).status).toBeLessThan(300);
  });
});

describe('standup feed', () => {
  it('hides the text of entries about projects the viewer cannot see', async () => {
    const owner = await signup();
    const [dev, qa] = [await inviteAndAccept(owner, 'member'), await inviteAndAccept(owner, 'member')];
    const sec = await project(owner, 'SEC', 'private');
    await post(owner, `/projects/${sec.id}/members`, { userId: id(dev), role: 'member' });
    const put = await request(app)
      .put(`${base}/standups/me`)
      .set(bearer(dev))
      .send({ yesterday: 'Audited the vault', today: 'Rotate keys', blockers: 'Pentest report', mood: 3, projectId: sec.id });
    expect(put.status).toBe(201);

    const outsider = ((await get(qa, '/standups')).body as StandupFeedDto).entries;
    expect(outsider).toHaveLength(1);
    expect(outsider[0]).toMatchObject({ user: { id: id(dev) }, projectId: null, yesterday: '', today: '', blockers: '', blockerTasks: [] });

    const admin = ((await get(owner, '/standups')).body as StandupFeedDto).entries;
    expect(admin[0]).toMatchObject({ projectId: sec.id, today: 'Rotate keys' });
    expect(((await get(dev, '/standups')).body as StandupFeedDto).mine).toMatchObject({ projectId: sec.id, today: 'Rotate keys' });
  });
});

describe('guest directory', () => {
  it('guests only see and find people they share a project with', async () => {
    const owner = await signup({ name: 'Olive Owner' });
    const guest = await inviteAndAccept(owner, 'guest');
    const [peer, stranger] = [await inviteAndAccept(owner, 'member'), await inviteAndAccept(owner, 'member')];
    const web = await project(owner, 'WEB');
    for (const s of [guest, peer]) await post(owner, `/projects/${web.id}/members`, { userId: id(s), role: 'member' });

    const list = await get(guest, '/users');
    expect(list.status).toBe(200);
    expect((list.body.items as { id: string }[]).map((u) => u.id).sort()).toEqual([id(owner), id(guest), id(peer)].sort());
    expect((await get(guest, `/users/${id(peer)}`)).status).toBe(200);
    expect((await get(guest, `/users/${id(stranger)}`)).status).toBe(404);

    const users = (r: SearchResponseDto) => r.groups.find((g) => g.type === 'user')?.items ?? [];
    const prefix = stranger.body.user.email.split('@')[0]!;
    expect(users((await get(guest, `/search?q=${prefix}`)).body as SearchResponseDto)).toHaveLength(0);
    expect(users((await get(owner, `/search?q=${prefix}`)).body as SearchResponseDto)).toHaveLength(1);

    // Non-guests still see everyone.
    expect(((await get(peer, '/users')).body.items as unknown[]).length).toBe(4);
    expect((await get(peer, `/users/${id(stranger)}`)).status).toBe(200);
  });
});
