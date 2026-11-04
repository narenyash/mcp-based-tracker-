import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import type { CalendarResponseDto, ProjectDto, SearchResponseDto, StandupDto, StandupFeedDto, StandupSuggestionsDto, TaskDto } from '@teamtrack/shared';
import { app, bearer, inviteAndAccept, signup, useTestDb, type TestSession } from './helpers';
import { Task, Workspace } from '../src/models';
import { registerSearchSource } from '../src/services/discovery';
import { localNow } from '../src/modules/planning/time';

useTestDb();

const base = '/api/v1';
const get = (s: TestSession, url: string) => request(app).get(base + url).set(bearer(s));
const post = (s: TestSession, url: string, body: object = {}) => request(app).post(base + url).set(bearer(s)).send(body);
const put = (s: TestSession, body: object, version?: number) => {
  const req = request(app).put(`${base}/standups/me`).set(bearer(s));
  return (version === undefined ? req : req.set('If-Match', `"${version}"`)).send(body);
};

async function createTask(s: TestSession, projectId: string, body: object): Promise<TaskDto> {
  const res = await post(s, `/projects/${projectId}/tasks`, body);
  if (res.status !== 201) throw new Error(`create failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as TaskDto;
}
const move = (s: TestSession, t: TaskDto, statusId: string) =>
  request(app).patch(`${base}/tasks/${t.id}/move`).set(bearer(s)).set('If-Match', `"${t.version}"`).send({ statusId });

/** Owner; dev + qa in the public "WEB" project; a private "SEC" project only the owner is in. */
async function setup() {
  const owner = await signup();
  const [dev, qa] = [await inviteAndAccept(owner, 'member'), await inviteAndAccept(owner, 'member')];
  const web = (await post(owner, '/projects', { key: 'WEB', name: 'Website' })).body as ProjectDto;
  const sec = (await post(owner, '/projects', { key: 'SEC', name: 'Security audit', visibility: 'private' })).body as ProjectDto;
  for (const s of [dev, qa]) await post(owner, `/projects/${web.id}/members`, { userId: s.body.user.id, role: 'member' });
  return { owner, dev, qa, web, sec, id: (s: TestSession) => s.body.user.id };
}

const search = async (s: TestSession, q: string) => {
  const res = await get(s, `/search?q=${encodeURIComponent(q)}`);
  expect(res.status).toBe(200);
  return res.body as SearchResponseDto;
};
const group = (r: SearchResponseDto, type: string) => r.groups.find((g) => g.type === type)?.items ?? [];

const workspaceOf = (s: TestSession) => new Types.ObjectId(s.body.workspace.id);
const setWorkspace = (s: TestSession, set: Record<string, unknown>) => Workspace.updateOne({ _id: workspaceOf(s) }, { $set: set });
const shift = (key: string, days: number) => new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

describe('global search', () => {
  it('puts an exact key match first and groups results in a fixed order', async () => {
    const { owner, web } = await setup();
    await createTask(owner, web.id, { title: 'Website footer' });
    await createTask(owner, web.id, { title: 'Hero copy' });
    await createTask(owner, web.id, { title: 'Mentions WEB-2 in the title' });

    const byKey = await search(owner, 'web-2');
    expect(group(byKey, 'task')[0]).toMatchObject({ title: 'WEB-2 Hero copy', subtitle: 'Website · To do' });
    expect(group(byKey, 'task')[0]!.path).toMatch(new RegExp(`^/projects/${web.id}\\?task=`));
    expect(group(byKey, 'task').map((h) => h.title)).toContain('WEB-3 Mentions WEB-2 in the title');

    const mixed = await search(owner, 'web');
    expect(mixed.groups.map((g) => g.type)).toEqual(['task', 'project']);
    expect(group(mixed, 'project')[0]).toMatchObject({ title: 'Website', path: `/projects/${web.id}` });
  });

  it('treats the query as text, not a pattern', async () => {
    const { owner, web } = await setup();
    await createTask(owner, web.id, { title: 'Weird (.* title' });
    await createTask(owner, web.id, { title: 'Plain title' });
    const res = await search(owner, '(.*');
    expect(group(res, 'task').map((h) => h.title)).toEqual(['WEB-1 Weird (.* title']);
    expect((await get(owner, '/search?q=')).status).toBe(400);
    expect((await get(owner, `/search?q=${'x'.repeat(81)}`)).status).toBe(400);
  });

  it('hides tasks and projects the caller cannot see', async () => {
    const { owner, dev, web, sec } = await setup();
    await createTask(owner, sec.id, { title: 'Rotate secret keys' });
    await createTask(owner, web.id, { title: 'Rotate banner images' });
    expect(group(await search(owner, 'rotate'), 'task')).toHaveLength(2);
    expect(group(await search(dev, 'rotate'), 'task').map((h) => h.title)).toEqual(['WEB-1 Rotate banner images']);
    expect(group(await search(dev, 'SEC-1'), 'task')).toHaveLength(0);
    expect(group(await search(dev, 'security'), 'project')).toHaveLength(0);
    expect(group(await search(owner, 'security'), 'project')).toHaveLength(1);
  });

  it('finds active people by name or email prefix', async () => {
    const { owner, dev } = await setup();
    const hits = group(await search(owner, dev.body.user.email.split('@')[0]!), 'user');
    expect(hits).toEqual([{ type: 'user', id: dev.body.user.id, title: dev.body.user.name, subtitle: dev.body.user.email, path: '/team' }]);
  });

  it('skips a source that throws or hangs instead of failing the request', async () => {
    const { owner, web } = await setup();
    await createTask(owner, web.id, { title: 'Resilient search' });
    registerSearchSource('test-throws', async () => {
      throw new Error('boom');
    });
    registerSearchSource('test-hangs', () => new Promise(() => {}));
    try {
      const started = Date.now();
      const res = await search(owner, 'resilient');
      expect(group(res, 'task')).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      registerSearchSource('test-throws', async () => []);
      registerSearchSource('test-hangs', async () => []);
    }
  });
});

describe('calendar', () => {
  it('validates the range', async () => {
    const { owner } = await setup();
    expect((await get(owner, '/calendar?from=2026-11-10&to=2026-11-01')).status).toBe(400);
    expect((await get(owner, '/calendar?from=2026-11-01&to=2027-01-02')).status).toBe(400); // 63 days
    expect((await get(owner, '/calendar?from=2026-11-01&to=2027-01-01')).status).toBe(200); // 62 days
    expect((await get(owner, '/calendar?from=2026-02-30&to=2026-03-01')).status).toBe(400);
    expect((await get(owner, `/calendar?from=2026-11-01&to=2026-11-30&projectId=${new Types.ObjectId().toHexString()}`)).status).toBe(404);
  });

  it('returns visible tasks due in the range, sorted, with status colours and the mine filter', async () => {
    const { owner, dev, web, sec, id } = await setup();
    const late = await createTask(owner, web.id, { title: 'Late', dueDate: '2026-11-20', assigneeId: id(dev) });
    await createTask(owner, web.id, { title: 'Early', dueDate: '2026-11-03' });
    await createTask(owner, web.id, { title: 'Outside', dueDate: '2026-12-15' });
    await createTask(owner, sec.id, { title: 'Private', dueDate: '2026-11-10' });
    await move(owner, late, 'done');

    const all = (await get(dev, '/calendar?from=2026-11-01&to=2026-11-30')).body as CalendarResponseDto;
    expect(all.items.map((i) => [i.date, i.title])).toEqual([
      ['2026-11-03', 'Early'],
      ['2026-11-20', 'Late'],
    ]);
    expect(all.items[1]).toMatchObject({ type: 'task', key: 'WEB-1', done: true, color: '#22c55e', path: `/projects/${web.id}?task=${late.id}` });
    expect(all.items[0]).toMatchObject({ done: false, color: '#a3a3a3' });

    const mine = (await get(dev, '/calendar?from=2026-11-01&to=2026-11-30&mine=true')).body as CalendarResponseDto;
    expect(mine.items.map((i) => i.title)).toEqual(['Late']);

    const owners = (await get(owner, `/calendar?from=2026-11-01&to=2026-11-30&projectId=${sec.id}`)).body as CalendarResponseDto;
    expect(owners.items.map((i) => i.title)).toEqual(['Private']);
    expect((await get(dev, `/calendar?from=2026-11-01&to=2026-11-30&projectId=${sec.id}`)).status).toBe(404);
  });
});

describe('standups', () => {
  const body = { yesterday: 'Did things', today: 'More things', blockers: '', mood: 4 };

  it('creates without a version, then requires If-Match to update (428 / 409), and is idempotent', async () => {
    const { dev } = await setup();
    const created = await put(dev, body);
    expect(created.status).toBe(201);
    const s = created.body as StandupDto;
    expect(created.headers.etag).toBe(`"${s.version}"`);
    expect(s).toMatchObject({ yesterday: 'Did things', mood: 4, user: { id: dev.body.user.id } });

    expect((await put(dev, { ...body, today: 'Changed' })).status).toBe(428);
    const updated = await put(dev, { ...body, today: 'Changed' }, s.version);
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(s.version + 1);
    expect((await put(dev, { ...body, today: 'Again' }, s.version)).status).toBe(409);

    const same = await put(dev, { ...body, today: 'Changed' }, s.version + 1);
    expect(same.status).toBe(200);
    expect(same.body.version).toBe(s.version + 1);
    expect(same.body.today).toBe('Changed');
  });

  it('only accepts today or yesterday in the workspace timezone', async () => {
    const { dev } = await setup();
    await setWorkspace(dev, { timezone: 'Pacific/Kiritimati' });
    const today = localNow('Pacific/Kiritimati').dateKey;
    const res = await put(dev, body);
    expect(res.body.date).toBe(today);
    expect((await put(dev, { ...body, date: shift(today, -1) })).status).toBe(201);
    for (const date of [shift(today, -2), shift(today, 1)]) {
      const bad = await put(dev, { ...body, date });
      expect(bad.status).toBe(400);
      expect(bad.body.errors[0].path).toBe('date');
    }
  });

  it('validates text length, mood and blocking tasks the user can see', async () => {
    const { owner, dev, web, sec } = await setup();
    const hidden = await createTask(owner, sec.id, { title: 'Hidden' });
    const visible = await createTask(owner, web.id, { title: 'Visible' });
    expect((await put(dev, { ...body, today: 'x'.repeat(2001) })).status).toBe(400);
    expect((await put(dev, { ...body, mood: 6 })).status).toBe(400);
    expect((await put(dev, { ...body, blockerTaskIds: Array.from({ length: 11 }, () => new Types.ObjectId().toHexString()) })).status).toBe(400);
    const bad = await put(dev, { ...body, blockerTaskIds: [hidden.id] });
    expect(bad.status).toBe(400);
    expect(bad.body.errors[0].path).toBe('blockerTaskIds');
    const ok = await put(dev, { ...body, blockers: 'Waiting on design', blockerTaskIds: [visible.id, visible.id] });
    expect(ok.status).toBe(201);
    expect(ok.body.blockerTasks).toEqual([{ id: visible.id, key: 'WEB-1', title: 'Visible', projectId: web.id }]);
  });

  it('shows the team feed with who has not posted, and nudges after standup time', async () => {
    const { owner, dev, qa } = await setup();
    await setWorkspace(owner, { 'settings.standupTime': '00:00', 'settings.workWeek': [1, 2, 3, 4, 5, 6, 7] });
    await put(dev, body);

    const feed = (await get(qa, '/standups')).body as StandupFeedDto;
    expect(feed.entries.map((e) => e.user.id)).toEqual([dev.body.user.id]);
    expect(feed.notPosted.map((p) => p.id).sort()).toEqual([owner.body.user.id, qa.body.user.id].sort());
    expect(feed).toMatchObject({ editable: true, nudge: true, mine: null, date: feed.today });

    const devFeed = (await get(dev, '/standups')).body as StandupFeedDto;
    expect(devFeed.nudge).toBe(false);
    expect(devFeed.mine?.user.id).toBe(dev.body.user.id);

    const old = (await get(qa, `/standups?date=${shift(feed.today, -5)}`)).body as StandupFeedDto;
    expect(old).toMatchObject({ editable: false, entries: [], nudge: true });
  });

  it('limits guests to people who share a project with them', async () => {
    const { owner, dev, qa, sec } = await setup();
    const guest = await inviteAndAccept(owner, 'guest');
    await post(owner, `/projects/${sec.id}/members`, { userId: guest.body.user.id, role: 'member' });
    await post(owner, `/projects/${sec.id}/members`, { userId: dev.body.user.id, role: 'member' });
    await put(dev, body);
    await put(qa, body);

    const feed = (await get(guest, '/standups')).body as StandupFeedDto;
    expect(feed.entries.map((e) => e.user.id)).toEqual([dev.body.user.id]);
    const notPosted = feed.notPosted.map((p) => p.id);
    expect(notPosted).toContain(guest.body.user.id);
    expect(notPosted).not.toContain(qa.body.user.id);

    const byProject = (await get(owner, `/standups?projectId=${sec.id}`)).body as StandupFeedDto;
    expect(byProject.entries.map((e) => e.user.id)).toEqual([dev.body.user.id]);
    expect((await get(qa, `/standups?projectId=${sec.id}`)).status).toBe(404);
  });

  it('pages through my history newest first', async () => {
    const { dev } = await setup();
    const today = (await put(dev, body)).body as StandupDto;
    await put(dev, { ...body, date: shift(today.date, -1) });
    const first = await get(dev, '/standups/me/history?limit=1');
    expect(first.body.items.map((s: StandupDto) => s.date)).toEqual([today.date]);
    const second = await get(dev, `/standups/me/history?limit=1&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((s: StandupDto) => s.date)).toEqual([shift(today.date, -1)]);
    expect(second.body.nextCursor).toBeNull();
  });

  it('suggests what I finished since the last working day and what I am working on', async () => {
    const { owner, dev, web, id } = await setup();
    const a = await createTask(owner, web.id, { title: 'Finished yesterday', assigneeId: id(dev) });
    const b = await createTask(owner, web.id, { title: 'Finished today', assigneeId: id(dev) });
    const c = await createTask(owner, web.id, { title: 'In progress', assigneeId: id(dev) });
    await createTask(owner, web.id, { title: 'Someone else', assigneeId: id(owner), statusId: 'in_progress' });
    await move(owner, a, 'done');
    await move(owner, b, 'done');
    await move(owner, c, 'in_progress');

    const first = (await get(dev, '/standups/me/suggestions')).body as StandupSuggestionsDto;
    expect(Date.parse(first.until)).toBeGreaterThan(Date.parse(first.since));
    await Task.updateOne({ workspaceId: workspaceOf(dev), _id: a.id }, { $set: { completedAt: new Date(Date.parse(first.since) + 3600_000) } });
    await Task.updateOne({ workspaceId: workspaceOf(dev), _id: b.id }, { $set: { completedAt: new Date(Date.parse(first.until) + 60_000) } });

    const s = (await get(dev, '/standups/me/suggestions')).body as StandupSuggestionsDto;
    expect(s.completed.map((t) => t.title)).toEqual(['Finished yesterday']);
    expect(s.inProgress.map((t) => t.title)).toEqual(['In progress']);
  });
});
