import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { GoalDetailDto, GoalDto, GoalListDto, GoalSummaryDto, ProjectDto, TaskDto } from '@teamtrack/shared';
import { app, bearer, inviteAndAccept, signup, useTestDb, type TestSession } from './helpers';
import { bus } from '../src/events/bus';
import { runJobOnce } from '../src/jobs/scheduler';
import { goalRollover } from '../src/modules/goals/goals.jobs';
import { goalsService } from '../src/modules/goals/goals.service';
import { calendarPeriod, canRollUp, keyRange, localDay, nextPeriod, periodContaining, zonedMidnight } from '../src/modules/goals/period';

useTestDb();

const base = '/api/v1';
const get = (s: TestSession, url: string) => request(app).get(base + url).set(bearer(s));
const post = (s: TestSession, url: string, body: object = {}) => request(app).post(base + url).set(bearer(s)).send(body);
const del = (s: TestSession, url: string) => request(app).delete(base + url).set(bearer(s));
const patch = (s: TestSession, g: Pick<GoalDto, 'id' | 'version'>, body: object, suffix = '') =>
  request(app).patch(`${base}/goals/${g.id}${suffix}`).set(bearer(s)).set('If-Match', `"${g.version}"`).send(body);
const progress = (s: TestSession, g: Pick<GoalDto, 'id' | 'version'>, body: object) => patch(s, g, body, '/progress');

async function createGoal(s: TestSession, body: object): Promise<GoalDto> {
  const res = await post(s, '/goals', body);
  if (res.status !== 201) throw new Error(`create goal failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as GoalDto;
}
async function createTask(s: TestSession, projectId: string, title: string): Promise<TaskDto> {
  const res = await post(s, `/projects/${projectId}/tasks`, { title });
  if (res.status !== 201) throw new Error(`create task failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as TaskDto;
}
const moveTask = (s: TestSession, t: TaskDto, statusId: string) =>
  request(app).patch(`${base}/tasks/${t.id}/move`).set(bearer(s)).set('If-Match', `"${t.version}"`).send({ statusId });

/** Owner, a manager, two members and a guest in one workspace (Asia/Kolkata). */
async function setup() {
  const owner = await signup();
  const manager = await inviteAndAccept(owner, 'manager');
  const [alice, bob] = [await inviteAndAccept(owner, 'member'), await inviteAndAccept(owner, 'member')];
  const guest = await inviteAndAccept(owner, 'guest');
  return { owner, manager, alice, bob, guest, id: (s: TestSession) => s.body.user.id };
}

describe('period math', () => {
  it('uses ISO weeks, including across the year boundary', () => {
    expect(calendarPeriod('weekly', '2026-12-31')).toEqual({ period: 'weekly', key: '2026-W53', start: '2026-12-28', end: '2027-01-03' });
    expect(calendarPeriod('weekly', '2027-01-03').key).toBe('2026-W53');
    expect(calendarPeriod('weekly', '2027-01-04').key).toBe('2027-W01');
    expect(calendarPeriod('weekly', '2024-12-30').key).toBe('2025-W01');
    expect(calendarPeriod('weekly', '2026-11-01')).toMatchObject({ key: '2026-W44', start: '2026-10-26', end: '2026-11-01' });
    expect(keyRange('weekly', '2026-W53')).toMatchObject({ start: '2026-12-28', end: '2027-01-03' });
    expect(keyRange('weekly', '2025-W01').start).toBe('2024-12-30');
  });

  it('handles month boundaries and leap years', () => {
    expect(calendarPeriod('monthly', '2026-02-10')).toMatchObject({ key: '2026-02', start: '2026-02-01', end: '2026-02-28' });
    expect(calendarPeriod('monthly', '2028-02-10').end).toBe('2028-02-29');
    expect(nextPeriod('monthly', '2026-12', 'UTC').key).toBe('2027-01');
    expect(nextPeriod('daily', '2026-10-31', 'UTC').key).toBe('2026-11-01');
    expect(nextPeriod('weekly', '2026-W53', 'UTC').key).toBe('2027-W01');
  });

  it('computes exact bounds in the workspace timezone', () => {
    const evening = new Date('2026-11-01T20:00:00.000Z');
    expect(localDay('Asia/Kolkata', evening)).toBe('2026-11-02');
    expect(localDay('UTC', evening)).toBe('2026-11-01');
    const day = periodContaining('daily', '2026-11-02', 'Asia/Kolkata');
    expect(day.periodStart.toISOString()).toBe('2026-11-01T18:30:00.000Z');
    expect(day.periodEnd.toISOString()).toBe('2026-11-02T18:30:00.000Z');
    // DST: New York springs forward on 2026-03-08.
    expect(zonedMidnight('America/New_York', '2026-03-08').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(zonedMidnight('America/New_York', '2026-03-09').toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });

  it('rolls up one level, into a period that shares days', () => {
    const day = calendarPeriod('daily', '2026-10-29');
    expect(canRollUp(day, calendarPeriod('weekly', '2026-10-27'))).toBe(true);
    expect(canRollUp(day, calendarPeriod('weekly', '2026-11-03'))).toBe(false);
    expect(canRollUp(day, calendarPeriod('monthly', '2026-10-01'))).toBe(false);
    // A straddling week may roll up into either month.
    const week = calendarPeriod('weekly', '2026-11-01');
    expect(canRollUp(week, calendarPeriod('monthly', '2026-10-01'))).toBe(true);
    expect(canRollUp(week, calendarPeriod('monthly', '2026-11-01'))).toBe(true);
    expect(canRollUp(week, calendarPeriod('monthly', '2026-12-01'))).toBe(false);
  });

  it('stores the period computed from the date and workspace timezone', async () => {
    const { alice } = await setup();
    const g = await createGoal(alice, { title: 'Ship it', period: 'weekly', date: '2026-12-31' });
    expect(g).toMatchObject({ periodKey: '2026-W53', startDate: '2026-12-28', endDate: '2027-01-03', status: 'active', scope: 'personal' });
    expect(g.periodStart).toBe('2026-12-27T18:30:00.000Z');
    expect(g.owner?.id).toBe(alice.body.user.id);

    const list = (await get(alice, '/goals?period=weekly&date=2027-01-02')).body as GoalListDto;
    expect(list.period).toEqual({ period: 'weekly', key: '2026-W53', start: '2026-12-28', end: '2027-01-03' });
    expect(list.items.map((x) => x.id)).toEqual([g.id]);
    expect((await get(alice, '/goals?period=weekly&date=2027-01-04')).body.items).toHaveLength(0);
  });
});

describe('permissions', () => {
  it('personal goals: everyone views, only the owner edits, guests see only their own', async () => {
    const { alice, bob, guest, owner } = await setup();
    const g = await createGoal(alice, { title: 'Read a book', period: 'daily', date: '2026-11-02' });
    expect((await get(bob, `/goals/${g.id}`)).status).toBe(200);
    expect((await get(bob, `/goals/${g.id}`)).body.canEdit).toBe(false);
    expect((await patch(bob, g, { title: 'Hacked' })).status).toBe(403);
    expect((await patch(owner, g, { title: 'Hacked' })).status).toBe(403);
    expect((await get(guest, `/goals/${g.id}`)).status).toBe(404);
    expect((await get(guest, '/goals?period=daily&date=2026-11-02&owner=team')).body.items).toHaveLength(0);
    expect((await get(bob, '/goals?period=daily&date=2026-11-02&owner=team')).body.items).toHaveLength(1);
    expect((await get(bob, '/goals?period=daily&date=2026-11-02')).body.items).toHaveLength(0); // owner=me
    expect((await post(bob, '/goals', { title: 'X', period: 'daily', ownerId: alice.body.user.id })).status).toBe(400);

    const ok = await patch(alice, g, { title: 'Read two books' });
    expect(ok.status).toBe(200);
    expect(ok.headers.etag).toBe(`"${ok.body.version}"`);
    // The guest's own goal is visible to them.
    const mine = await createGoal(guest, { title: 'Learn the tool', period: 'daily', date: '2026-11-02' });
    expect((await get(guest, `/goals/${mine.id}`)).status).toBe(200);
  });

  it('team goals: managers create and edit, members view', async () => {
    const { manager, alice, id } = await setup();
    expect((await post(alice, '/goals', { title: 'Team', scope: 'team', period: 'monthly' })).status).toBe(403);
    const g = await createGoal(manager, { title: 'Close 20 deals', scope: 'team', period: 'monthly', measure: 'number', target: 20, ownerId: id(alice) });
    expect(g.owner?.id).toBe(id(alice));
    expect((await get(alice, `/goals/${g.id}`)).status).toBe(200);
    expect((await progress(alice, g, { current: 5 })).status).toBe(403);
    expect((await progress(manager, g, { current: 5 })).body.progressPct).toBe(25);
  });

  it('project goals: leads and admins edit; visible only to those who can see the project', async () => {
    const { owner, manager, alice, bob } = await setup();
    const p = (await post(manager, '/projects', { key: 'SEC', name: 'Secret', visibility: 'private' })).body as ProjectDto;
    await post(manager, `/projects/${p.id}/members`, { userId: alice.body.user.id, role: 'member' });
    expect((await post(alice, '/goals', { title: 'X', scope: 'project', projectId: p.id, period: 'weekly' })).status).toBe(403);
    expect((await post(manager, '/goals', { title: 'X', scope: 'project', period: 'weekly' })).status).toBe(400);
    const g = await createGoal(manager, { title: 'Launch beta', scope: 'project', projectId: p.id, period: 'weekly' });

    expect((await get(bob, `/goals/${g.id}`)).status).toBe(404);
    expect((await get(bob, '/goals?period=weekly&owner=team')).body.items).toHaveLength(0);
    expect((await get(alice, `/goals/${g.id}`)).status).toBe(200);
    expect((await patch(alice, g, { title: 'Nope' })).status).toBe(403);
    const byAdmin = await patch(owner, g, { title: 'Launch public beta' });
    expect(byAdmin.status).toBe(200);
    expect((await patch(manager, byAdmin.body as GoalDto, { description: 'All regions' })).status).toBe(200);
  });

  it('requires If-Match and rejects stale versions', async () => {
    const { alice } = await setup();
    const g = await createGoal(alice, { title: 'Draft', period: 'daily' });
    expect((await patch(alice, g, { title: 'One' })).status).toBe(200);
    const stale = await patch(alice, g, { title: 'Two' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    expect((await progress(alice, g, { current: 1 })).status).toBe(409);
    expect((await request(app).patch(`${base}/goals/${g.id}`).set(bearer(alice)).send({ title: 'No etag' })).status).toBe(428);
  });
});

describe('progress', () => {
  it('comes from key results when there are any', async () => {
    const { alice } = await setup();
    const g = await createGoal(alice, {
      title: 'Get fit',
      period: 'weekly',
      measure: 'number',
      target: 100,
      keyResults: [
        { title: 'Run', target: 10, unit: 'km' },
        { title: 'Gym sessions', target: 4 },
      ],
    });
    expect(g.progressPct).toBe(0);
    const [run, gym] = g.keyResults;
    const res = await progress(alice, g, { keyResults: [{ id: run!.id, current: 5 }, { id: gym!.id, current: 4 }] });
    expect(res.status).toBe(200);
    expect(res.body.progressPct).toBe(75);
    expect(res.body.status).toBe('active');
    const done = await progress(alice, res.body as GoalDto, { keyResults: [{ id: run!.id, current: 12 }] });
    expect(done.body.progressPct).toBe(100);
    expect(done.body.status).toBe('achieved');
    // Editing the key results keeps ids for existing ones.
    const edited = await patch(alice, done.body as GoalDto, { keyResults: [{ id: run!.id, title: 'Run', target: 20, current: 12, unit: 'km' }] });
    expect(edited.body.keyResults).toHaveLength(1);
    expect(edited.body.keyResults[0].id).toBe(run!.id);
    expect(edited.body.progressPct).toBe(60);
    expect(edited.body.status).toBe('active');
  });

  it('uses current/target, or yes/no', async () => {
    const { alice } = await setup();
    const n = await createGoal(alice, { title: 'Write words', period: 'daily', measure: 'number', target: 2000, unit: 'words' });
    expect((await progress(alice, n, { current: 500 })).body.progressPct).toBe(25);
    const b = await createGoal(alice, { title: 'Call mom', period: 'daily' });
    const yes = await progress(alice, b, { current: 1 });
    expect(yes.body).toMatchObject({ progressPct: 100, status: 'achieved' });
    const t = await createGoal(alice, { title: 'Tasks', period: 'daily', measure: 'tasks' });
    expect((await progress(alice, t, { current: 1 })).status).toBe(400);
  });

  it('follows linked tasks as they move', async () => {
    const { owner, alice, manager } = await setup();
    const p = (await post(owner, '/projects', { key: 'WEB', name: 'Website' })).body as ProjectDto;
    await post(owner, `/projects/${p.id}/members`, { userId: alice.body.user.id, role: 'member' });
    const [t1, t2] = [await createTask(owner, p.id, 'Hero'), await createTask(owner, p.id, 'Footer')];
    const g = await createGoal(alice, { title: 'Ship the site', period: 'weekly', measure: 'tasks', linkedTaskIds: [t1.id, t2.id] });
    expect(g.tasks).toEqual({ total: 2, done: 0 });

    expect((await moveTask(owner, t1, 'done')).status).toBe(200);
    await bus.drain();
    let now = (await get(alice, `/goals/${g.id}`)).body as GoalDetailDto;
    expect(now).toMatchObject({ progressPct: 50, tasks: { total: 2, done: 1 }, status: 'active', version: g.version });
    expect(now.linkedTasks.map((t) => [t.key, t.statusCategory])).toEqual([
      ['WEB-1', 'done'],
      ['WEB-2', 'todo'],
    ]);

    const t2Now = (await get(owner, `/tasks/${t2.id}`)).body as TaskDto;
    await moveTask(owner, t2Now, 'done');
    await bus.drain();
    now = (await get(alice, `/goals/${g.id}`)).body as GoalDetailDto;
    expect(now).toMatchObject({ progressPct: 100, status: 'achieved' });

    // Deleting a linked task drops it from the goal.
    const t3 = await createTask(owner, p.id, 'Blog');
    const linked = await post(alice, `/goals/${g.id}/link-task`, { taskId: t3.id });
    expect(linked.body).toMatchObject({ progressPct: 67, status: 'active', tasks: { total: 3, done: 2 } });
    expect((await del(owner, `/tasks/${t3.id}`)).status).toBe(204);
    await bus.drain();
    now = (await get(alice, `/goals/${g.id}`)).body as GoalDetailDto;
    expect(now).toMatchObject({ progressPct: 100, status: 'achieved', linkedTaskIds: [t1.id, t2.id] });

    // Tasks in projects the actor can't see can't be linked.
    const priv = (await post(manager, '/projects', { key: 'PRV', name: 'Private', visibility: 'private' })).body as ProjectDto;
    const hidden = await createTask(manager, priv.id, 'Hidden');
    expect((await post(alice, `/goals/${g.id}/link-task`, { taskId: hidden.id })).status).toBe(400);
    expect((await post(alice, '/goals', { title: 'X', period: 'daily', linkedTaskIds: [hidden.id] })).status).toBe(400);

    const unlinked = await request(app).delete(`${base}/goals/${g.id}/link-task/${t2.id}`).set(bearer(alice));
    expect(unlinked.body).toMatchObject({ tasks: { total: 1, done: 1 }, linkedTaskIds: [t1.id] });
    expect((await request(app).delete(`${base}/goals/${g.id}/link-task/${t2.id}`).set(bearer(alice))).status).toBe(404);
  });
});

describe('carry-over and rollover', () => {
  it('carries the remaining target into the next period and links both goals', async () => {
    const { alice, bob } = await setup();
    const g = await createGoal(alice, { title: 'Sell 10', period: 'weekly', date: '2026-10-20', measure: 'number', target: 10 });
    const g2 = (await progress(alice, g, { current: 4 })).body as GoalDto;
    expect((await post(bob, `/goals/${g.id}/carry-over`)).status).toBe(403);

    const res = await post(alice, `/goals/${g.id}/carry-over`);
    expect(res.status).toBe(201);
    const copy = res.body as GoalDto;
    expect(copy).toMatchObject({ periodKey: '2026-W44', target: 6, current: 0, status: 'active', carriedFromId: g.id, title: 'Sell 10' });
    const original = (await get(alice, `/goals/${g.id}`)).body as GoalDto;
    expect(original).toMatchObject({ status: 'carried_over', carriedToId: copy.id });
    expect(original.version).toBeGreaterThan(g2.version);
    expect((await post(alice, `/goals/${g.id}/carry-over`)).status).toBe(409);
    expect((await progress(alice, original, { current: 5 })).status).toBe(409);
  });

  it('closes ended periods as achieved or missed, once', async () => {
    const { alice } = await setup();
    const hit = await createGoal(alice, { title: 'Done', period: 'daily', date: '2026-10-01' });
    const hitNow = (await progress(alice, hit, { current: 1 })).body as GoalDto;
    // The period is over, so reaching 100% leaves it for the rollover to close.
    expect(hitNow).toMatchObject({ progressPct: 100, status: 'active' });
    const miss = await createGoal(alice, { title: 'Not done', period: 'daily', date: '2026-10-01' });
    const future = await createGoal(alice, { title: 'Later', period: 'monthly', date: '2099-01-01' });

    expect(await goalsService.rollover()).toEqual({ achieved: 1, missed: 1 });
    expect(await goalsService.rollover()).toEqual({ achieved: 0, missed: 0 });
    expect((await get(alice, `/goals/${hit.id}`)).body).toMatchObject({ status: 'achieved', version: hitNow.version });
    expect((await get(alice, `/goals/${miss.id}`)).body.status).toBe('missed');
    expect((await get(alice, `/goals/${future.id}`)).body.status).toBe('active');

    // The scheduled job wraps the same work (leased).
    const late = await createGoal(alice, { title: 'Also late', period: 'daily', date: '2026-10-02' });
    expect(await runJobOnce(goalRollover)).toBe(true);
    expect((await get(alice, `/goals/${late.id}`)).body.status).toBe('missed');

    // A missed goal can still be carried over.
    const carried = await post(alice, `/goals/${miss.id}/carry-over`);
    expect(carried.status).toBe(201);
    expect(carried.body.periodKey).toBe('2026-10-02');
  });
});

describe('roll-up, summary, delete', () => {
  it('validates parents one level up that contain the period, and lists children', async () => {
    const { alice } = await setup();
    const week = await createGoal(alice, { title: 'Week', period: 'weekly', date: '2026-10-28' });
    const month = await createGoal(alice, { title: 'Month', period: 'monthly', date: '2026-10-28' });
    const child = await createGoal(alice, { title: 'Day', period: 'daily', date: '2026-10-29', parentGoalId: week.id });
    expect(child.parentGoalId).toBe(week.id);
    const wrongWeek = await post(alice, '/goals', { title: 'X', period: 'daily', date: '2026-11-05', parentGoalId: week.id });
    expect(wrongWeek.status).toBe(400);
    expect(wrongWeek.body.errors[0].path).toBe('parentGoalId');
    expect((await post(alice, '/goals', { title: 'X', period: 'daily', date: '2026-10-29', parentGoalId: month.id })).status).toBe(400);
    expect((await post(alice, '/goals', { title: 'X', period: 'monthly', parentGoalId: month.id })).status).toBe(400);
    expect((await patch(alice, week, { parentGoalId: month.id })).status).toBe(200);

    const detail = (await get(alice, `/goals/${week.id}`)).body as GoalDetailDto;
    expect(detail.children.map((c) => c.id)).toEqual([child.id]);

    expect((await del(alice, `/goals/${week.id}`)).status).toBe(204);
    expect((await get(alice, `/goals/${week.id}`)).status).toBe(404);
    expect((await get(alice, `/goals/${child.id}`)).body.parentGoalId).toBeNull();
  });

  it('summarises per person for managers, and self + team for members', async () => {
    const { manager, alice, bob } = await setup();
    // The current week: progress only flips a goal to achieved while its period is running.
    const date = localDay('Asia/Kolkata', new Date());
    const weekKey = periodContaining('weekly', date, 'Asia/Kolkata').key;
    const a = await createGoal(alice, { title: 'A1', period: 'weekly', date });
    await createGoal(alice, { title: 'A2', period: 'weekly', date });
    await progress(alice, a, { current: 1 });
    await createGoal(bob, { title: 'B1', period: 'weekly', date });
    await createGoal(manager, { title: 'Team', scope: 'team', period: 'weekly', date });

    const all = (await get(manager, `/goals/summary?period=weekly&date=${date}`)).body as GoalSummaryDto;
    expect(all.period.key).toBe(weekKey);
    const aliceRow = all.people.find((p) => p.user.id === alice.body.user.id);
    expect(aliceRow).toMatchObject({ goals: 2, achieved: 1, avgProgress: 50 });
    expect(all.people).toHaveLength(3);
    expect(all.team).toEqual({ goals: 1, achieved: 0, avgProgress: 0 });

    const mine = (await get(bob, `/goals/summary?period=weekly&date=${date}`)).body as GoalSummaryDto;
    expect(mine.people.map((p) => p.user.id)).toEqual([bob.body.user.id]);
    expect(mine.team.goals).toBe(1);
  });

  it('cancels and reopens', async () => {
    const { alice } = await setup();
    const g = await createGoal(alice, { title: 'Maybe', period: 'monthly' });
    const cancelled = await patch(alice, g, { status: 'cancelled' });
    expect(cancelled.body.status).toBe('cancelled');
    expect((await post(alice, `/goals/${g.id}/carry-over`)).status).toBe(409);
    const reopened = await patch(alice, cancelled.body as GoalDto, { status: 'active' });
    expect(reopened.body.status).toBe('active');
  });
});
