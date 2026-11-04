import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type {
  GoalDto,
  MyDashboardDto,
  ProjectDto,
  TaskDto,
  TeamReportDto,
  TicketDto,
} from '@teamtrack/shared';
import { app, bearer, inviteAndAccept, signup, useTestDb, type TestSession } from './helpers';
import { addDays, isoWeek, localDay } from '../src/modules/goals/period';

useTestDb();

const base = '/api/v1';
const TZ = 'Asia/Kolkata'; // the default workspace timezone
const get = (s: TestSession, url: string) =>
  request(app)
    .get(base + url)
    .set(bearer(s));
const post = (s: TestSession, url: string, body: object = {}) =>
  request(app)
    .post(base + url)
    .set(bearer(s))
    .send(body);

async function created<T>(res: request.Response): Promise<T> {
  if (res.status !== 201)
    throw new Error(`create failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T;
}
const createTask = async (s: TestSession, projectId: string, body: object) =>
  created<TaskDto>(await post(s, `/projects/${projectId}/tasks`, body));
const createTicket = async (s: TestSession, projectId: string, body: object) =>
  created<TicketDto>(await post(s, `/projects/${projectId}/tickets`, body));
const createGoal = async (s: TestSession, body: object) =>
  created<GoalDto>(await post(s, '/goals', body));

async function move<T extends { id: string; version: number }>(
  s: TestSession,
  kind: 'tasks' | 'tickets',
  t: T,
  body: object,
): Promise<T> {
  const res = await request(app)
    .patch(`${base}/${kind}/${t.id}/move`)
    .set(bearer(s))
    .set('If-Match', `"${t.version}"`)
    .send(body);
  if (res.status !== 200) throw new Error(`move failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T;
}

async function report(s: TestSession, query = ''): Promise<TeamReportDto> {
  const res = await get(s, `/reports/team${query}`);
  if (res.status !== 200)
    throw new Error(`report failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as TeamReportDto;
}

const today = () => localDay(TZ, new Date());
const weekKey = (day: string) => {
  const w = isoWeek(day);
  return `${w.year}-W${String(w.week).padStart(2, '0')}`;
};

/**
 * Owner (admin), a manager, two members (dev, qa). WEB is workspace-visible with dev + qa as members;
 * SEC is private to the owner.
 *
 * WEB tasks: t1 dev todo overdue · t2 dev in progress due today · t3 dev passed testing on round 1 (done)
 *            t4 qa done directly · t5 unassigned todo · t6 dev in testing (qa testing, pending)
 * SEC tasks: s1 owner todo overdue
 * WEB tickets: k1 bug/high open · k2 incident/critical resolved · k3 request/low open, assigned to dev
 * Goals: dev weekly (achieved) + dev weekly (0%) + dev daily (0%) + team weekly by the manager (0%)
 */
async function seed() {
  const owner = await signup();
  const manager = await inviteAndAccept(owner, 'manager');
  const dev = await inviteAndAccept(owner, 'member');
  const qa = await inviteAndAccept(owner, 'member');
  const id = (s: TestSession) => s.body.user.id;
  const web = await created<ProjectDto>(
    await post(owner, '/projects', { key: 'WEB', name: 'Website' }),
  );
  const sec = await created<ProjectDto>(
    await post(owner, '/projects', { key: 'SEC', name: 'Security', visibility: 'private' }),
  );
  for (const s of [dev, qa])
    await post(owner, `/projects/${web.id}/members`, { userId: id(s), role: 'member' });

  const day = today();
  await createTask(owner, web.id, { title: 't1', assigneeId: id(dev), dueDate: addDays(day, -1) });
  await createTask(owner, web.id, {
    title: 't2',
    assigneeId: id(dev),
    statusId: 'in_progress',
    dueDate: day,
  });
  const t3 = await createTask(owner, web.id, {
    title: 't3',
    assigneeId: id(dev),
    statusId: 'in_progress',
  });
  await move(qa, 'tasks', await move(dev, 'tasks', t3, { statusId: 'testing', testerId: id(qa) }), {
    statusId: 'done',
  });
  await move(owner, 'tasks', await createTask(owner, web.id, { title: 't4', assigneeId: id(qa) }), {
    statusId: 'done',
  });
  await createTask(owner, web.id, { title: 't5' });
  const t6 = await createTask(owner, web.id, {
    title: 't6',
    assigneeId: id(dev),
    statusId: 'in_progress',
  });
  await move(dev, 'tasks', t6, { statusId: 'testing', testerId: id(qa) });
  await createTask(owner, sec.id, {
    title: 's1',
    assigneeId: id(owner),
    dueDate: addDays(day, -3),
  });

  await createTicket(owner, web.id, { title: 'k1', type: 'bug', severity: 'high' });
  const k2 = await createTicket(owner, web.id, {
    title: 'k2',
    type: 'incident',
    severity: 'critical',
  });
  await move(owner, 'tickets', k2, { statusId: 'resolved', resolution: 'fixed' });
  await createTicket(owner, web.id, {
    title: 'k3',
    type: 'request',
    severity: 'low',
    assigneeId: id(dev),
  });

  await createGoal(dev, { title: 'Ship it', period: 'weekly', current: 1 });
  await createGoal(dev, { title: 'Write docs', period: 'weekly' });
  await createGoal(dev, { title: 'Inbox zero', period: 'daily' });
  await createGoal(manager, { title: 'Team goal', scope: 'team', period: 'weekly' });

  return { owner, manager, dev, qa, web, sec, id };
}

describe('GET /reports/team', () => {
  it('computes the numbers for a seeded scenario (admin sees everything)', async () => {
    const { owner, dev, qa, id } = await seed();
    const r = await report(owner);

    expect(r.scope).toBe('team');
    expect(r.projectId).toBeNull();
    expect(r.range.to).toBe(today());
    expect(r.range.timezone).toBe(TZ);
    expect(r.weeks).toHaveLength(8);
    expect(r.range.from).toBe(r.weeks[0]!.start);
    expect(new Date(`${r.range.from}T00:00:00Z`).getUTCDay()).toBe(1); // a Monday

    expect(r.tasks.byStatus).toEqual({ todo: 3, in_progress: 1, testing: 1, done: 2 });
    expect(r.tasks).toMatchObject({ open: 5, overdue: 2, created: 7, completed: 2 });
    expect(r.tasks.avgLeadTimeDays).toBe(0);
    expect(r.testing).toEqual({ passed: 1, passedFirstRound: 1, firstPassRate: 100 });

    const row = (uid: string | null) => r.assignees.find((a) => (a.user?.id ?? null) === uid);
    expect(row(id(dev))).toMatchObject({
      open: 3,
      inProgress: 1,
      testing: 1,
      overdue: 1,
      completed: 1,
    });
    expect(row(id(owner))).toMatchObject({ open: 1, overdue: 1, completed: 0 });
    expect(row(id(qa))).toMatchObject({ open: 0, completed: 1 });
    expect(row(null)).toMatchObject({ user: null, open: 1 });
    expect(r.assignees[0]!.user?.id).toBe(id(dev)); // heaviest load first

    const thisWeek = r.weeks.at(-1)!;
    expect(thisWeek).toMatchObject({
      week: weekKey(today()),
      tasksDone: 2,
      ticketsOpened: 3,
      ticketsClosed: 1,
      goals: 3,
      goalsAchieved: 1,
    });
    expect(r.weeks.slice(0, -1).every((w) => w.tasksDone === 0 && w.ticketsOpened === 0)).toBe(
      true,
    );

    expect(r.tickets).toMatchObject({ opened: 3, closed: 1, openNow: 2 });
    expect(r.tickets.bySeverity).toEqual([
      { key: 'low', opened: 1, open: 1 },
      { key: 'medium', opened: 0, open: 0 },
      { key: 'high', opened: 1, open: 1 },
      { key: 'critical', opened: 1, open: 0 },
    ]);
    expect(r.tickets.byType.find((t) => t.key === 'incident')).toEqual({
      key: 'incident',
      opened: 1,
      open: 0,
    });

    expect(r.goals).toMatchObject({ total: 4, achieved: 1, completionPct: 25, avgProgress: 25 });
    expect(r.goals.byPeriod.weekly).toEqual({
      total: 3,
      achieved: 1,
      completionPct: 33,
      avgProgress: 33,
    });
    expect(r.goals.byPeriod.daily).toEqual({
      total: 1,
      achieved: 0,
      completionPct: 0,
      avgProgress: 0,
    });
    expect(r.goals.byPeriod.monthly).toEqual({
      total: 0,
      achieved: 0,
      completionPct: null,
      avgProgress: null,
    });
  });

  it('narrows to one project and to a date range', async () => {
    const { owner, web, sec } = await seed();
    const webOnly = await report(owner, `?projectId=${web.id}`);
    expect(webOnly.projectId).toBe(web.id);
    expect(webOnly.tasks.byStatus).toEqual({ todo: 2, in_progress: 1, testing: 1, done: 2 });
    expect(webOnly.goals.total).toBe(0); // no project goals
    expect((await report(owner, `?projectId=${sec.id}`)).tasks.open).toBe(1);

    const past = await report(owner, '?from=2025-01-06&to=2025-02-02');
    expect(past.weeks.map((w) => w.week)).toEqual(['2025-W02', '2025-W03', '2025-W04', '2025-W05']);
    expect(past.tasks).toMatchObject({ completed: 0, created: 0, avgLeadTimeDays: null });
    expect(past.tasks.open).toBe(5); // the status snapshot is current, not range-bound
    expect(past.tickets).toMatchObject({ opened: 0, closed: 0, openNow: 2 });
    expect(past.testing.firstPassRate).toBeNull();
    expect(past.goals.total).toBe(0);
  });

  it('gives managers the team view of the projects they can see, and members only their own work', async () => {
    const { manager, dev, sec, id } = await seed();

    const m = await report(manager);
    expect(m.scope).toBe('team');
    expect(m.tasks.byStatus).toEqual({ todo: 2, in_progress: 1, testing: 1, done: 2 }); // not the private SEC project
    expect(m.tasks.overdue).toBe(1);
    expect(m.goals.total).toBe(4);
    expect((await get(manager, `/reports/team?projectId=${sec.id}`)).status).toBe(404);

    const d = await report(dev);
    expect(d.scope).toBe('self');
    expect(d.tasks.byStatus).toEqual({ todo: 1, in_progress: 1, testing: 1, done: 1 });
    expect(d.assignees.map((a) => a.user?.id)).toEqual([id(dev)]);
    expect(d.tickets).toMatchObject({ opened: 1, openNow: 1 }); // only k3, assigned to dev
    expect(d.goals).toMatchObject({ total: 3, achieved: 1 });
    expect(d.testing).toEqual({ passed: 1, passedFirstRound: 1, firstPassRate: 100 });
    expect((await get(dev, `/reports/team?projectId=${sec.id}`)).status).toBe(404);
  });

  it('never counts another workspace', async () => {
    const { owner, web } = await seed();
    const other = await signup({ workspaceName: 'Other' });
    const op = await created<ProjectDto>(
      await post(other, '/projects', { key: 'OTH', name: 'Other' }),
    );
    await move(
      other,
      'tasks',
      await createTask(other, op.id, { title: 'x', assigneeId: other.body.user.id }),
      { statusId: 'done' },
    );
    await createTicket(other, op.id, { title: 'y' });
    await createGoal(other, { title: 'z', period: 'weekly', current: 1 });

    const r = await report(owner);
    expect(r.tasks).toMatchObject({ created: 7, completed: 2, open: 5 });
    expect(r.tickets.opened).toBe(3);
    expect(r.goals.total).toBe(4);
    expect(r.assignees.some((a) => a.user?.id === other.body.user.id)).toBe(false);

    const o = await report(other);
    expect(o.tasks).toMatchObject({ created: 1, completed: 1, open: 0 });
    expect(o.tickets.opened).toBe(1);
    expect((await get(other, `/reports/team?projectId=${web.id}`)).status).toBe(404);
  });

  it('validates the range', async () => {
    const owner = await signup();
    const status = async (q: string) => (await get(owner, `/reports/team${q}`)).status;
    expect(await status('?from=2026-03-10&to=2026-03-01')).toBe(400);
    expect(await status('?from=2025-01-01&to=2026-01-02')).toBe(400); // 367 days
    expect(await status('?from=2025-01-01&to=2026-01-01')).toBe(200); // 366 days
    expect(await status('?from=2026-02-30&to=2026-03-01')).toBe(400);
    expect(await status('?from=yesterday')).toBe(400);
    expect(await status('?projectId=nope')).toBe(400);
    expect(await status(`?from=${addDays(today(), -400)}`)).toBe(400); // open-ended range still capped
    expect(await status(`?from=${addDays(today(), 3)}`)).toBe(400); // starts after today (the default end)
    expect(await status(`?from=${addDays(today(), -10)}`)).toBe(200);
    expect((await request(app).get(`${base}/reports/team`)).status).toBe(401);
  });
});

describe('GET /dashboard/me', () => {
  it("returns the caller's tasks, goals, tickets and others' activity on their things", async () => {
    const { owner, dev, qa, id } = await seed();
    const res = await get(dev, '/dashboard/me');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const d = res.body as MyDashboardDto;

    expect(d.today).toBe(today());
    expect(d.weekEnd).toBe(addDays(isoWeek(today()).monday, 6));
    expect(d.tasks).toEqual({
      open: 3,
      todo: 1,
      inProgress: 1,
      testing: 1,
      dueToday: 1,
      dueThisWeek: 1,
      overdue: 1,
      waitingForMyTesting: 0,
    });
    expect(d.openTickets).toBe(1);
    expect(d.dueSoon.map((t) => [t.title, t.overdue])).toEqual([
      ['t1', true],
      ['t2', false],
    ]);
    expect(d.goals.week).toMatchObject({
      key: weekKey(today()),
      total: 2,
      achieved: 1,
      avgProgress: 50,
    });
    expect(d.goals.week.items.map((g) => g.title)).toEqual(['Write docs', 'Ship it']); // lowest progress first
    expect(d.goals.today).toMatchObject({ key: today(), total: 1, achieved: 0 });

    expect(d.activity.length).toBeGreaterThan(0);
    expect(d.activity.length).toBeLessThanOrEqual(10);
    expect(d.activity.every((a) => a.actor?.id !== id(dev))).toBe(true);
    expect(d.activity.some((a) => a.actor?.id === id(qa) && a.entityType === 'task')).toBe(true); // qa passed t3
    expect(d.activity.some((a) => a.entityType === 'ticket' && a.actor?.id === id(owner))).toBe(
      true,
    ); // k3

    const q = (await get(qa, '/dashboard/me')).body as MyDashboardDto;
    expect(q.tasks).toMatchObject({ open: 0, waitingForMyTesting: 1 });
    expect(q.goals.week.total).toBe(0);
  });

  it('counts only the caller workspace', async () => {
    const { owner } = await seed();
    const other = await signup({ workspaceName: 'Other' });
    const op = await created<ProjectDto>(
      await post(other, '/projects', { key: 'OTH', name: 'Other' }),
    );
    await createTask(other, op.id, {
      title: 'x',
      assigneeId: other.body.user.id,
      dueDate: today(),
    });

    const d = (await get(owner, '/dashboard/me')).body as MyDashboardDto;
    expect(d.tasks).toMatchObject({ open: 1, overdue: 1, dueToday: 0 }); // s1 only
    const o = (await get(other, '/dashboard/me')).body as MyDashboardDto;
    expect(o.tasks).toMatchObject({ open: 1, dueToday: 1, overdue: 0 });
    expect(o.activity).toEqual([]); // only their own actions
  });
});
