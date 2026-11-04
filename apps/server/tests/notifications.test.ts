import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { io as connect, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, NotificationDto, Page, ProjectDto, ServerToClientEvents, TaskChangedEvent, TaskDto } from '@teamtrack/shared';
import { app, bearer, inviteAndAccept, signup, useTestDb, type TestSession } from './helpers';
import { EmailLog, JobLock, Notification, Outbox } from '../src/models';
import { processOne } from '../src/workers/outboxWorker';
import { sendDueReminders } from '../src/jobs/dueReminders';
import { runJobOnce } from '../src/jobs/scheduler';
import { attachRealtime, closeRealtime } from '../src/services/realtime';

useTestDb();

const base = '/api/v1';
const get = (s: TestSession, url: string) => request(app).get(base + url).set(bearer(s));
const post = (s: TestSession, url: string, body: object = {}) => request(app).post(base + url).set(bearer(s)).send(body);
const patch = (s: TestSession, url: string, body: object, version?: number) => {
  const r = request(app).patch(base + url).set(bearer(s));
  return (version === undefined ? r : r.set('If-Match', `"${version}"`)).send(body);
};
const drain = async () => {
  while (await processOne());
};

async function setup() {
  const owner = await signup();
  const [dev, qa] = [await inviteAndAccept(owner, 'member'), await inviteAndAccept(owner, 'member')];
  const project = (await post(owner, '/projects', { key: 'WEB', name: 'Website' })).body as ProjectDto;
  for (const s of [dev, qa]) await post(owner, `/projects/${project.id}/members`, { userId: s.body.user.id, role: 'member' });
  await drain(); // invite emails
  return { owner, dev, qa, project, id: (s: TestSession) => s.body.user.id };
}

async function createTask(s: TestSession, projectId: string, body: object): Promise<TaskDto> {
  const res = await post(s, `/projects/${projectId}/tasks`, body);
  if (res.status !== 201) throw new Error(`create failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as TaskDto;
}

describe('notifications', () => {
  it('assignment creates one notification and one email, delivered by the worker', async () => {
    const { owner, dev, project, id } = await setup();
    const t = await createTask(owner, project.id, { title: 'Login page', assigneeId: id(dev) });
    // Nothing is delivered until the transaction's outbox row is processed.
    expect(await Notification.countDocuments({}).setOptions({ skipTenant: true })).toBe(0);
    await drain();

    const list = (await get(dev, '/notifications')).body as Page<NotificationDto>;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      type: 'task_assigned',
      title: 'Owner assigned you WEB-1',
      body: 'Login page',
      entityType: 'task',
      entityKey: 'WEB-1',
      path: `/projects/${project.id}?task=${t.id}`,
      actor: { id: id(owner), name: 'Owner' },
      readAt: null,
    });
    expect(await EmailLog.countDocuments({ to: dev.body.user.email, template: 'taskAssigned', status: 'sent' })).toBe(1);
    // The owner did it, so the owner gets nothing.
    expect(((await get(owner, '/notifications')).body as Page<NotificationDto>).items).toHaveLength(0);

    // Re-running a delivered message (e.g. a crash before it was marked done) doesn't duplicate anything.
    await Outbox.updateMany({ type: 'notify' }, { $set: { status: 'pending', nextAttemptAt: new Date() } });
    await drain();
    expect(await Notification.countDocuments({}).setOptions({ skipTenant: true })).toBe(1);
    expect(await EmailLog.countDocuments({ to: dev.body.user.email, template: 'taskAssigned' })).toBe(1);
  });

  it('tracks unread, marks one or all read, and keeps notifications private', async () => {
    const { owner, dev, qa, project, id } = await setup();
    await createTask(owner, project.id, { title: 'A', assigneeId: id(dev) });
    await createTask(owner, project.id, { title: 'B', assigneeId: id(dev) });
    await createTask(owner, project.id, { title: 'C', assigneeId: id(dev) });
    await drain();

    expect((await get(dev, '/notifications/unread-count')).body).toEqual({ count: 3 });
    const page1 = (await get(dev, '/notifications?limit=2')).body as Page<NotificationDto>;
    expect(page1.items.map((n) => n.body)).toEqual(['C', 'B']);
    const page2 = (await get(dev, `/notifications?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`)).body as Page<NotificationDto>;
    expect(page2.items.map((n) => n.body)).toEqual(['A']);

    const first = page1.items[0]!;
    expect((await post(qa, `/notifications/${first.id}/read`)).status).toBe(404);
    expect((await post(dev, `/notifications/${first.id}/read`)).status).toBe(204);
    expect((await get(dev, '/notifications/unread-count')).body).toEqual({ count: 2 });
    expect(((await get(dev, '/notifications?unread=true')).body as Page<NotificationDto>).items).toHaveLength(2);

    expect((await post(dev, '/notifications/read-all')).body).toEqual({ updated: 2 });
    expect((await get(dev, '/notifications/unread-count')).body).toEqual({ count: 0 });
  });

  it('respects email preferences but always notifies in-app', async () => {
    const { owner, dev, project, id } = await setup();
    expect((await get(dev, '/users/me/preferences')).body).toEqual({ email: { assigned: true, testing: true, dueSoon: true, mentioned: true } });
    const res = await patch(dev, '/users/me/preferences', { email: { assigned: false } });
    expect(res.body).toEqual({ email: { assigned: false, testing: true, dueSoon: true, mentioned: true } });
    expect((await patch(dev, '/users/me/preferences', { email: {} })).status).toBe(400);
    expect((await patch(dev, '/users/me/preferences', { email: { digest: true } })).status).toBe(400);

    await createTask(owner, project.id, { title: 'Quiet', assigneeId: id(dev) });
    await drain();
    expect(await Notification.countDocuments({ type: 'task_assigned' }).setOptions({ skipTenant: true })).toBe(1);
    expect(await EmailLog.countDocuments({ to: dev.body.user.email, template: 'taskAssigned' })).toBe(0);
  });

  it('tells the assignee when their work passes testing', async () => {
    const { owner, dev, qa, project, id } = await setup();
    const t = await createTask(owner, project.id, { title: 'Checkout', assigneeId: id(dev) });
    const sent = (await patch(dev, `/tasks/${t.id}/move`, { statusId: 'testing', testerId: id(qa) }, t.version)).body as TaskDto;
    expect((await patch(qa, `/tasks/${t.id}/move`, { statusId: 'done' }, sent.version)).status).toBe(200);
    await drain();

    const types = ((await get(dev, '/notifications')).body as Page<NotificationDto>).items.map((n) => n.type);
    expect(types).toEqual(['test_passed', 'task_assigned']);
    expect(((await get(qa, '/notifications')).body as Page<NotificationDto>).items.map((n) => n.title)).toEqual(['member person asked you to test WEB-1']);
    expect(await EmailLog.countDocuments({ to: dev.body.user.email, template: 'testPassed' })).toBe(1);
  });
});

describe('due-date reminders', () => {
  // 10:30 in Asia/Kolkata (the default workspace timezone) on 2 Nov 2026.
  const morning = new Date('2026-11-02T05:00:00.000Z');

  it('reminds the assignee once per due date, and again if the date changes', async () => {
    const { owner, dev, project, id } = await setup();
    const soon = await createTask(owner, project.id, { title: 'Ship', assigneeId: id(dev), dueDate: '2026-11-03' });
    await createTask(owner, project.id, { title: 'Later', assigneeId: id(dev), dueDate: '2026-11-20' });
    await createTask(owner, project.id, { title: 'Nobody', dueDate: '2026-11-02' });
    await createTask(owner, project.id, { title: 'Late', assigneeId: id(dev), dueDate: '2026-10-30' });
    await drain();
    await Notification.deleteMany({}).setOptions({ skipTenant: true });

    expect(await sendDueReminders(morning)).toBe(2);
    expect(await sendDueReminders(morning)).toBe(0);
    await drain();
    const titles = ((await get(dev, '/notifications')).body as Page<NotificationDto>).items.map((n) => n.title).sort();
    expect(titles).toEqual(['WEB-1 is due tomorrow', 'WEB-4 is overdue']);
    expect(await EmailLog.countDocuments({ to: dev.body.user.email, template: 'taskDue' })).toBe(2);

    // Reminder bookkeeping doesn't bump the version, so open editors don't get a 409.
    const fresh = (await get(dev, `/tasks/${soon.id}`)).body as TaskDto;
    expect(fresh.version).toBe(soon.version);
    const moved = (await patch(owner, `/tasks/${soon.id}`, { dueDate: '2026-11-02' }, fresh.version)).body as TaskDto;
    expect(moved.dueDate).toBe('2026-11-02');
    expect(await sendDueReminders(morning)).toBe(1);
  });

  it('stays quiet outside working hours and skips finished tasks', async () => {
    const { owner, dev, project, id } = await setup();
    const t = await createTask(owner, project.id, { title: 'Ship', assigneeId: id(dev), dueDate: '2026-11-02' });
    expect(await sendDueReminders(new Date('2026-11-01T21:30:00.000Z'))).toBe(0); // 03:00 IST
    await patch(owner, `/tasks/${t.id}/move`, { statusId: 'done' }, t.version);
    expect(await sendDueReminders(morning)).toBe(0);
  });

  it('runs a scheduled job on one instance at a time', async () => {
    let runs = 0;
    const job = { name: 'test-job', everyMs: 60_000, leaseMs: 10_000, run: async () => void runs++ };
    const now = new Date();
    const results = await Promise.all([runJobOnce(job, now), runJobOnce(job, now), runJobOnce(job, now)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(runs).toBe(1);
    // Not due again until everyMs has passed.
    expect(await runJobOnce(job)).toBe(false);
    expect((await JobLock.findById('test-job').lean())?.lockedUntil).toBeNull();
  });
});

describe('live updates', () => {
  let server: Server;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    server = createServer(app);
    attachRealtime(server, async () => true);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    sockets.forEach((s) => s.close());
    await closeRealtime();
    await new Promise((resolve) => server.close(resolve));
  });

  function open(token: string): Promise<Socket<ServerToClientEvents, ClientToServerEvents>> {
    const s: Socket<ServerToClientEvents, ClientToServerEvents> = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    sockets.push(s);
    return new Promise((resolve, reject) => {
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  }
  const next = <E extends keyof ServerToClientEvents>(s: Socket<ServerToClientEvents, ClientToServerEvents>, event: E, ms = 3000) =>
    new Promise<Parameters<ServerToClientEvents[E]>[0]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${event} within ${ms}ms`)), ms);
      s.once(event, ((payload: Parameters<ServerToClientEvents[E]>[0]) => {
        clearTimeout(timer);
        resolve(payload);
      }) as never);
    });

  it('rejects sockets without a valid access token', async () => {
    await expect(open('not-a-token')).rejects.toThrow('unauthorized');
  });

  it('pushes board changes to the project room, except to the socket that made them', async () => {
    const { owner, dev, project } = await setup();
    const [ownerSocket, devSocket] = [await open(owner.token), await open(dev.token)];
    for (const s of [ownerSocket, devSocket]) expect(await s.emitWithAck('project:join', project.id)).toEqual({ ok: true });
    expect(await devSocket.emitWithAck('project:join', 'nope')).toEqual({ ok: false });

    let echoed = false;
    ownerSocket.on('task:changed', () => (echoed = true));
    const change = next(devSocket, 'task:changed');
    const res = await request(app).post(`${base}/projects/${project.id}/tasks`).set(bearer(owner)).set('x-socket-id', ownerSocket.id!).send({ title: 'Live' });
    const e = (await change) as TaskChangedEvent;
    expect(e).toEqual({ projectId: project.id, taskId: (res.body as TaskDto).id, parentTaskId: null, kind: 'created', actorId: owner.body.user.id });
    await new Promise((r) => setTimeout(r, 100));
    expect(echoed).toBe(false);
  });

  it('pushes new notifications to the recipient only', async () => {
    const { owner, dev, project, id } = await setup();
    const [ownerSocket, devSocket] = [await open(owner.token), await open(dev.token)];
    let ownerGot = false;
    ownerSocket.on('notification:new', () => (ownerGot = true));
    const incoming = next(devSocket, 'notification:new');
    await createTask(owner, project.id, { title: 'Ping', assigneeId: id(dev) });
    await drain();
    expect(((await incoming) as NotificationDto).title).toBe('Owner assigned you WEB-1');
    expect(ownerGot).toBe(false);
  });
});
