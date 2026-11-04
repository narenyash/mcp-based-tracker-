import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import type { ConvertTicketResultDto, Page, ProjectDto, TaskDto, TicketBoardDto, TicketDto } from '@teamtrack/shared';
import { app, bearer, inviteAndAccept, signup, useTestDb, type TestSession } from './helpers';
import { Outbox } from '../src/models';
import { Ticket } from '../src/models/Ticket';
import { listSearchSources } from '../src/services/discovery';
import { resolveEntity } from '../src/services/entityAccess';

useTestDb();

const base = '/api/v1';
const get = (s: TestSession, url: string) => request(app).get(base + url).set(bearer(s));
const post = (s: TestSession, url: string, body: object = {}) => request(app).post(base + url).set(bearer(s)).send(body);
const del = (s: TestSession, url: string) => request(app).delete(base + url).set(bearer(s));
const patch = (s: TestSession, t: Pick<TicketDto, 'id' | 'version'>, body: object) =>
  request(app).patch(`${base}/tickets/${t.id}`).set(bearer(s)).set('If-Match', `"${t.version}"`).send(body);
const move = (s: TestSession, t: Pick<TicketDto, 'id' | 'version'>, body: object) =>
  request(app).patch(`${base}/tickets/${t.id}/move`).set(bearer(s)).set('If-Match', `"${t.version}"`).send(body);

async function createTicket(s: TestSession, projectId: string, body: object): Promise<TicketDto> {
  const res = await post(s, `/projects/${projectId}/tickets`, body);
  if (res.status !== 201) throw new Error(`create failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as TicketDto;
}

/** Owner + lead of project "WEB" with a member (dev) and a viewer. */
async function setup() {
  const owner = await signup();
  const [dev, viewer] = [await inviteAndAccept(owner, 'member'), await inviteAndAccept(owner, 'member')];
  const project = (await post(owner, '/projects', { key: 'WEB', name: 'Website' })).body as ProjectDto;
  await post(owner, `/projects/${project.id}/members`, { userId: dev.body.user.id, role: 'member' });
  await post(owner, `/projects/${project.id}/members`, { userId: viewer.body.user.id, role: 'viewer' });
  return { owner, dev, viewer, project, id: (s: TestSession) => s.body.user.id };
}

const notifyRows = (type: string, userId: string) => Outbox.find({ type: 'notify', 'payload.type': type, 'payload.userId': userId }).lean();

describe('ticket basics', () => {
  it('numbers tickets workspace-wide (TCK-n) across projects and starts them in the first status', async () => {
    const { owner, project } = await setup();
    const other = (await post(owner, '/projects', { key: 'APP', name: 'App' })).body as ProjectDto;
    const a = await createTicket(owner, project.id, { title: 'Login broken', type: 'bug', severity: 'high', environment: { browser: 'Firefox 130' } });
    const b = await createTicket(owner, other.id, { title: 'Export to CSV', type: 'request' });
    const c = await createTicket(owner, project.id, { title: 'Footer typo', severity: 'low' });
    expect([a.key, b.key, c.key]).toEqual(['TCK-1', 'TCK-2', 'TCK-3']);
    expect(a.statusId).toBe('open');
    expect(a.statusCategory).toBe('todo');
    expect(a.environment).toEqual({ browser: 'Firefox 130', os: '', url: '', version: '' });
    expect(a.reporter?.id).toBe(owner.body.user.id);
    expect(c.rank > a.rank).toBe(true);
    expect((await createTicket(owner, project.id, { title: 'x', statusId: 'triaged' })).statusId).toBe('triaged');
  });

  it('allocates unique numbers under concurrent creates', async () => {
    const { owner, project } = await setup();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => post(owner, `/projects/${project.id}/tickets`, { title: `T${i}` })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(results.map((r) => (r.body as TicketDto).number).sort((x, y) => x - y)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  });

  it('validates input: done status on create, unknown status, assignee eligibility', async () => {
    const { owner, viewer, project, id } = await setup();
    expect((await post(owner, `/projects/${project.id}/tickets`, { title: '' })).status).toBe(400);
    expect((await post(owner, `/projects/${project.id}/tickets`, { title: 'x', statusId: 'resolved' })).status).toBe(400);
    expect((await post(owner, `/projects/${project.id}/tickets`, { title: 'x', statusId: 'nope' })).status).toBe(400);
    expect((await post(owner, `/projects/${project.id}/tickets`, { title: 'x', type: 'feature' })).status).toBe(400);
    const asViewer = await post(owner, `/projects/${project.id}/tickets`, { title: 'x', assigneeId: id(viewer) });
    expect(asViewer.status).toBe(400);
    expect(asViewer.body.errors[0].message).toMatch(/viewer/);
    const outsider = await inviteAndAccept(owner, 'member');
    expect((await post(owner, `/projects/${project.id}/tickets`, { title: 'x', assigneeId: id(outsider) })).status).toBe(400);
  });

  it('updates fields with If-Match; stale versions get 409 and a missing header 428', async () => {
    const { owner, project } = await setup();
    const t = await createTicket(owner, project.id, { title: 'Crash on save' });
    const ok = await patch(owner, t, { severity: 'critical', stepsToReproduce: '1. Open\n2. Save', environment: { os: 'macOS 15' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.etag).toBe(`"${t.version + 1}"`);
    expect(ok.body.severity).toBe('critical');
    expect(ok.body.environment.os).toBe('macOS 15');
    const stale = await patch(owner, t, { title: 'Other' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    expect((await request(app).patch(`${base}/tickets/${t.id}`).set(bearer(owner)).send({ title: 'x' })).status).toBe(428);
  });
});

describe('listing', () => {
  it('filters by state, type, severity, assignee, reporter and q (title or key), and sorts by severity', async () => {
    const { owner, dev, project, id } = await setup();
    const a = await createTicket(owner, project.id, { title: 'Payment fails', type: 'bug', severity: 'critical', assigneeId: id(dev) });
    await createTicket(dev, project.id, { title: 'Add dark mode', type: 'request', severity: 'low' });
    const c = await createTicket(owner, project.id, { title: 'Slow search', type: 'issue', severity: 'medium' });
    await move(owner, c, { statusId: 'resolved', resolution: 'fixed' });

    const keys = async (qs: string, s: TestSession = owner) => ((await get(s, `/tickets?${qs}`)).body as Page<TicketDto>).items.map((t) => t.key);
    expect(await keys('state=open')).toHaveLength(2);
    expect(await keys('state=done')).toEqual(['TCK-3']);
    expect(await keys('type=request')).toEqual(['TCK-2']);
    expect(await keys('severity=critical')).toEqual(['TCK-1']);
    expect(await keys('assignee=me', dev)).toEqual(['TCK-1']);
    expect(await keys('reporter=me', dev)).toEqual(['TCK-2']);
    expect(await keys('q=payment')).toEqual(['TCK-1']);
    expect(await keys('q=tck-3')).toEqual(['TCK-3']);
    expect(await keys(`projectId=${project.id}&sort=severity`)).toEqual(['TCK-1', 'TCK-3', 'TCK-2']);
    expect(await keys('statusId=resolved')).toEqual(['TCK-3']);
    expect(a.assignee?.id).toBe(id(dev));
  });

  it('paginates with a keyset cursor', async () => {
    const { owner, project } = await setup();
    for (let i = 0; i < 5; i++) await createTicket(owner, project.id, { title: `T${i}` });
    const first = (await get(owner, '/tickets?limit=2&sort=created')).body as Page<TicketDto>;
    expect(first.items).toHaveLength(2);
    const second = (await get(owner, `/tickets?limit=2&sort=created&cursor=${first.nextCursor}`)).body as Page<TicketDto>;
    const third = (await get(owner, `/tickets?limit=2&sort=created&cursor=${second.nextCursor}`)).body as Page<TicketDto>;
    expect([...first.items, ...second.items, ...third.items].map((t) => t.key)).toEqual(['TCK-5', 'TCK-4', 'TCK-3', 'TCK-2', 'TCK-1']);
    expect(third.nextCursor).toBeNull();
  });

  it('hides tickets of private projects from non-members, and 404s them', async () => {
    const { owner, dev } = await setup();
    const lead = await inviteAndAccept(owner, 'manager');
    const priv = (await post(lead, '/projects', { key: 'SEC', name: 'Secret', visibility: 'private' })).body as ProjectDto;
    const t = await createTicket(lead, priv.id, { title: 'Hidden' });
    expect(((await get(dev, '/tickets')).body as Page<TicketDto>).items).toHaveLength(0);
    expect((await get(dev, `/tickets/${t.id}`)).status).toBe(404);
    expect((await patch(dev, t, { title: 'x' })).status).toBe(404);
    expect((await get(dev, `/projects/${priv.id}/ticket-board`)).status).toBe(404);
    // Admins (the owner) see everything.
    expect(((await get(owner, '/tickets')).body as Page<TicketDto>).items).toHaveLength(1);
  });
});

describe('resolution workflow', () => {
  it('requires a resolution to resolve, clears it on reopen and counts reopens', async () => {
    const { owner, project } = await setup();
    let t = await createTicket(owner, project.id, { title: 'Broken image' });

    const missing = await move(owner, t, { statusId: 'resolved' });
    expect(missing.status).toBe(400);
    expect(missing.body.errors[0].path).toBe('resolution');
    expect((await move(owner, t, { statusId: 'in_progress', resolution: 'fixed' })).status).toBe(400);

    const resolved = await move(owner, t, { statusId: 'resolved', resolution: 'fixed' });
    expect(resolved.status).toBe(200);
    t = resolved.body as TicketDto;
    expect(t.resolution).toBe('fixed');
    expect(t.resolvedAt).toBeTruthy();
    expect(t.resolvedBy?.id).toBe(owner.body.user.id);

    // Resolved -> Closed keeps the resolution.
    t = (await move(owner, t, { statusId: 'closed' })).body as TicketDto;
    expect(t.statusId).toBe('closed');
    expect(t.resolution).toBe('fixed');

    const reopened = await move(owner, t, { statusId: 'open' });
    expect(reopened.status).toBe(200);
    t = reopened.body as TicketDto;
    expect(t.resolution).toBeNull();
    expect(t.resolvedAt).toBeNull();
    expect(t.reopenCount).toBe(1);

    t = (await move(owner, t, { statusId: 'resolved', resolution: 'wont_fix' })).body as TicketDto;
    t = (await move(owner, t, { statusId: 'triaged' })).body as TicketDto;
    expect(t.reopenCount).toBe(2);
  });

  it('links duplicates to another ticket of the same project', async () => {
    const { owner, project } = await setup();
    const original = await createTicket(owner, project.id, { title: 'Login broken' });
    const dupe = await createTicket(owner, project.id, { title: 'Cannot sign in' });
    expect((await move(owner, dupe, { statusId: 'resolved', resolution: 'fixed', duplicateOfId: original.id })).status).toBe(400);
    expect((await move(owner, dupe, { statusId: 'resolved', resolution: 'duplicate', duplicateOfId: dupe.id })).status).toBe(400);
    const res = await move(owner, dupe, { statusId: 'resolved', resolution: 'duplicate', duplicateOfId: original.id });
    expect(res.status).toBe(200);
    expect(res.body.duplicateOf).toEqual({ id: original.id, key: 'TCK-1' });
    // Changing the resolution afterwards drops the duplicate link.
    const fixed = await patch(owner, res.body as TicketDto, { resolution: 'fixed' });
    expect(fixed.body.duplicateOf).toBeNull();
    // Open tickets can't be given a resolution through PATCH.
    expect((await patch(owner, original, { resolution: 'fixed' })).status).toBe(400);
  });

  it('orders cards within a column by neighbour ids', async () => {
    const { owner, project } = await setup();
    const a = await createTicket(owner, project.id, { title: 'A' });
    const b = await createTicket(owner, project.id, { title: 'B' });
    const c = await createTicket(owner, project.id, { title: 'C' });
    expect((await move(owner, c, { statusId: 'open', afterId: a.id, beforeId: b.id })).status).toBe(200);
    const board = (await get(owner, `/projects/${project.id}/ticket-board`)).body as TicketBoardDto;
    expect(board.tickets.map((t) => t.title)).toEqual(['A', 'C', 'B']);
    expect(board.truncated).toBe(false);
    // A neighbour from another column is a stale board.
    const moved = (await move(owner, a, { statusId: 'triaged' })).body as TicketDto;
    expect((await move(owner, b, { statusId: 'open', afterId: moved.id })).status).toBe(409);
  });
});

describe('notifications', () => {
  it('notifies the assignee (not self-assignment) and the reporter when someone else resolves', async () => {
    const { owner, dev, project, id } = await setup();
    const t = await createTicket(dev, project.id, { title: 'Bug from dev' });
    const assigned = await patch(owner, t, { assigneeId: id(dev) });
    expect(assigned.status).toBe(200);
    const rows = await notifyRows('ticket_assigned', id(dev));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ subject: { type: 'ticket', id: t.id, key: 'TCK-1' }, path: `/tickets?ticket=${t.id}` });

    await createTicket(owner, project.id, { title: 'Mine', assigneeId: id(owner) });
    expect(await notifyRows('ticket_assigned', id(owner))).toHaveLength(0);

    await move(owner, assigned.body as TicketDto, { statusId: 'resolved', resolution: 'cannot_reproduce', note: 'Works on Chrome 130' });
    const resolved = await notifyRows('ticket_resolved', id(dev));
    expect(resolved).toHaveLength(1);
    expect((resolved[0]!.payload as { note: string }).note).toBe('Cannot reproduce: Works on Chrome 130');

    // Resolving your own ticket notifies nobody.
    const own = await createTicket(owner, project.id, { title: 'Own' });
    await move(owner, own, { statusId: 'resolved', resolution: 'fixed' });
    expect(await notifyRows('ticket_resolved', id(owner))).toHaveLength(0);
  });
});

describe('permissions', () => {
  it('viewers read but cannot write; archived projects are read-only', async () => {
    const { owner, viewer, project } = await setup();
    const t = await createTicket(owner, project.id, { title: 'Visible' });
    expect((await get(viewer, `/tickets/${t.id}`)).status).toBe(200);
    expect((await post(viewer, `/projects/${project.id}/tickets`, { title: 'x' })).status).toBe(403);
    expect((await patch(viewer, t, { title: 'x' })).status).toBe(403);
    expect((await del(viewer, `/tickets/${t.id}`)).status).toBe(403);

    const p = (await get(owner, `/projects/${project.id}`)).body as ProjectDto;
    await request(app).patch(`${base}/projects/${project.id}`).set(bearer(owner)).set('If-Match', `"${p.version}"`).send({ status: 'archived' });
    expect((await patch(owner, t, { title: 'x' })).status).toBe(409);
  });

  it('only the reporter, a lead or a manager can delete; deleted tickets 404', async () => {
    const { owner, dev, project } = await setup();
    const byOwner = await createTicket(owner, project.id, { title: 'Owner ticket' });
    const byDev = await createTicket(dev, project.id, { title: 'Dev ticket' });
    expect((await del(dev, `/tickets/${byOwner.id}`)).status).toBe(403);
    expect((await del(dev, `/tickets/${byDev.id}`)).status).toBe(204);
    expect((await get(owner, `/tickets/${byDev.id}`)).status).toBe(404);
    expect(await Ticket.countDocuments({ workspaceId: new Types.ObjectId(owner.body.workspace.id), deletedAt: { $ne: null } })).toBe(1);
    expect((await del(owner, `/tickets/${byOwner.id}`)).status).toBe(204);
  });
});

describe('tasks', () => {
  it('converts a ticket into a linked task with mapped priority', async () => {
    const { owner, dev, project, id } = await setup();
    const t = await createTicket(owner, project.id, { title: 'Checkout crash', severity: 'critical', assigneeId: id(dev), stepsToReproduce: 'Pay with UPI' });
    const res = await post(owner, `/tickets/${t.id}/convert-to-task`);
    expect(res.status).toBe(201);
    const { ticket, task } = res.body as ConvertTicketResultDto;
    expect(task.key).toBe('WEB-1');
    expect(task.title).toBe('Checkout crash');
    expect(task.priority).toBe('urgent');
    expect(task.assignee?.id).toBe(id(dev));
    expect(task.description).toContain('Pay with UPI');
    expect(task.description).toContain('TCK-1');
    expect(ticket.linkedTasks.map((l) => l.id)).toEqual([task.id]);
    expect(ticket.version).toBe(t.version + 1);
  });

  it('links and unlinks tasks of the same project only', async () => {
    const { owner, project } = await setup();
    const other = (await post(owner, '/projects', { key: 'APP', name: 'App' })).body as ProjectDto;
    const task = (await post(owner, `/projects/${project.id}/tasks`, { title: 'Fix it' })).body as TaskDto;
    const foreign = (await post(owner, `/projects/${other.id}/tasks`, { title: 'Elsewhere' })).body as TaskDto;
    const t = await createTicket(owner, project.id, { title: 'Bug' });

    expect((await post(owner, `/tickets/${t.id}/links`, { taskId: foreign.id })).status).toBe(400);
    const linked = await post(owner, `/tickets/${t.id}/links`, { taskId: task.id });
    expect(linked.status).toBe(200);
    expect(linked.body.linkedTasks).toEqual([{ id: task.id, key: 'WEB-1', title: 'Fix it', projectId: project.id, statusId: 'todo', statusCategory: 'todo' }]);
    // Linking twice is a no-op.
    expect((await post(owner, `/tickets/${t.id}/links`, { taskId: task.id })).body.linkedTasks).toHaveLength(1);

    // A deleted task drops out of the list.
    await del(owner, `/tasks/${task.id}`);
    expect(((await get(owner, `/tickets/${t.id}`)).body as TicketDto).linkedTasks).toHaveLength(0);

    const unlinked = await del(owner, `/tickets/${t.id}/links/${task.id}`);
    expect(unlinked.status).toBe(200);
    expect((await del(owner, `/tickets/${t.id}/links/${task.id}`)).status).toBe(404);
  });
});

describe('discovery', () => {
  it('resolves the ticket entity and finds tickets by title or key, respecting visibility', async () => {
    const { owner, dev, project } = await setup();
    const t = await createTicket(owner, project.id, { title: 'Payment page blank' });
    const lead = await inviteAndAccept(owner, 'manager');
    const priv = (await post(lead, '/projects', { key: 'SEC', name: 'Secret', visibility: 'private' })).body as ProjectDto;
    await createTicket(lead, priv.id, { title: 'Payment secret' });

    const search = listSearchSources().find(([name]) => name === 'tickets')![1];
    const ctxOf = (s: TestSession) => ({
      userId: new Types.ObjectId(s.body.user.id),
      workspaceId: new Types.ObjectId(s.body.workspace.id),
      role: s.body.user.role,
      sessionId: new Types.ObjectId(),
    });
    const hits = await search(ctxOf(dev), 'payment', 10);
    expect(hits).toEqual([{ type: 'ticket', id: t.id, title: 'TCK-1 Payment page blank', subtitle: 'Website · Open', path: `/tickets?ticket=${t.id}` }]);
    expect((await search(ctxOf(dev), 'tck-1', 10)).map((h) => h.id)).toEqual([t.id]);
    expect(await search(ctxOf(owner), 'payment', 10)).toHaveLength(2);

    const info = await resolveEntity(ctxOf(dev), 'ticket', t.id);
    expect(info).toMatchObject({ key: 'TCK-1', canWrite: true, canManage: false, path: `/tickets?ticket=${t.id}` });
  });
});
