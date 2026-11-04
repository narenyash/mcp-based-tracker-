import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { ProjectDto, TaskDto } from '@teamtrack/shared';
import { app, bearer, inviteAndAccept, signup, useTestDb, type TestSession } from './helpers';
import { Outbox, Task } from '../src/models';
import { Types } from 'mongoose';
import { processOne } from '../src/workers/outboxWorker';

useTestDb();

const base = '/api/v1';
const get = (s: TestSession, url: string) => request(app).get(base + url).set(bearer(s));
const post = (s: TestSession, url: string, body: object = {}) => request(app).post(base + url).set(bearer(s)).send(body);
const del = (s: TestSession, url: string) => request(app).delete(base + url).set(bearer(s));

async function createTask(s: TestSession, projectId: string, body: object): Promise<TaskDto> {
  const res = await post(s, `/projects/${projectId}/tasks`, body);
  if (res.status !== 201) throw new Error(`create failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as TaskDto;
}
const patch = (s: TestSession, t: Pick<TaskDto, 'id' | 'version'>, body: object) =>
  request(app).patch(`${base}/tasks/${t.id}`).set(bearer(s)).set('If-Match', `"${t.version}"`).send(body);
const move = (s: TestSession, t: Pick<TaskDto, 'id' | 'version'>, body: object) =>
  request(app).patch(`${base}/tasks/${t.id}/move`).set(bearer(s)).set('If-Match', `"${t.version}"`).send(body);

/** Owner + lead project "WEB" with two members (dev, qa) and a viewer. */
async function setup() {
  const owner = await signup();
  const [dev, qa, viewer] = [await inviteAndAccept(owner, 'member'), await inviteAndAccept(owner, 'member'), await inviteAndAccept(owner, 'member')];
  const project = (await post(owner, '/projects', { key: 'WEB', name: 'Website' })).body as ProjectDto;
  for (const [s, role] of [[dev, 'member'], [qa, 'member'], [viewer, 'viewer']] as const) {
    await post(owner, `/projects/${project.id}/members`, { userId: s.body.user.id, role });
  }
  return { owner, dev, qa, viewer, project, id: (s: TestSession) => s.body.user.id };
}

/** Runs the outbox worker until idle (notify -> in-app + email), then returns the emails sent to `to`. */
async function emailsTo(to: string, template: string) {
  while (await processOne());
  return Outbox.find({ type: 'email.send', 'payload.to': to, 'payload.template': template }).lean();
}

describe('task basics', () => {
  it('creates tasks with sequential readable keys in the first column', async () => {
    const { owner, project } = await setup();
    const a = await createTask(owner, project.id, { title: 'Hero section' });
    const b = await createTask(owner, project.id, { title: 'Footer', priority: 'high', dueDate: '2026-11-15' });
    expect([a.key, b.key]).toEqual(['WEB-1', 'WEB-2']);
    expect(a.statusId).toBe('todo');
    expect(a.reporter?.id).toBe(owner.body.user.id);
    expect(b.rank > a.rank).toBe(true);
    expect(b.dueDate).toBe('2026-11-15');
    expect(b.priority).toBe('high');
  });

  it('allocates unique numbers under concurrent creates', async () => {
    const { owner, project } = await setup();
    const results = await Promise.all(Array.from({ length: 15 }, (_, i) => post(owner, `/projects/${project.id}/tasks`, { title: `T${i}` })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => (r.body as TaskDto).number).sort((x, y) => x - y);
    expect(numbers).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it('assignees must be project members who can edit, and get an email (but not for self-assignment)', async () => {
    const { owner, dev, viewer, project, id } = await setup();
    const outsider = await inviteAndAccept(owner, 'member');
    // A plain member can't pull someone else into the project by assigning them.
    const byMember = await post(dev, `/projects/${project.id}/tasks`, { title: 'X', assigneeId: id(outsider) });
    expect(byMember.status).toBe(400);
    expect(byMember.body.errors[0].message).toMatch(/isn't in this project/);
    expect((await post(owner, `/projects/${project.id}/tasks`, { title: 'X', assigneeId: id(viewer) })).status).toBe(400);

    const t = await createTask(owner, project.id, { title: 'Login page', assigneeId: id(dev) });
    expect(t.assignee?.id).toBe(id(dev));
    const mail = await emailsTo(dev.body.user.email, 'taskAssigned');
    expect(mail).toHaveLength(1);
    expect((mail[0]!.payload as { data: { taskKey: string } }).data.taskKey).toBe('WEB-1');

    await createTask(dev, project.id, { title: 'Mine', assigneeId: id(dev) });
    expect(await emailsTo(dev.body.user.email, 'taskAssigned')).toHaveLength(1);
  });

  it('lets you assign yourself even when not yet a project member (you join it)', async () => {
    const { owner, dev, project, id } = await setup();
    const lead = await inviteAndAccept(owner, 'manager');
    const p = (await post(lead, '/projects', { key: 'APP', name: 'App' })).body as ProjectDto;
    // The workspace owner isn't a member of the manager's project, but can self-assign.
    const t = await createTask(lead, p.id, { title: 'Spec' });
    const mine = await patch(owner, t, { assigneeId: id(owner) });
    expect(mine.status).toBe(200);
    expect(mine.body.assignee.id).toBe(id(owner));
    const members = (await get(lead, `/projects/${p.id}/members`)).body.items as { userId: string; role: string }[];
    expect(members.find((m) => m.userId === id(owner))?.role).toBe('member');
    expect(((await get(lead, `/projects/${p.id}`)).body as ProjectDto).memberCount).toBe(2);
    // No email for assigning yourself.
    expect(await emailsTo(owner.body.user.email, 'taskAssigned')).toHaveLength(0);

    // A lead can assign anyone who can see the project; they join too.
    const assigned = await createTask(lead, p.id, { title: 'Build', assigneeId: id(dev) });
    expect(assigned.assignee?.id).toBe(id(dev));
    expect(((await get(lead, `/projects/${p.id}`)).body as ProjectDto).memberCount).toBe(3);
    expect(project.id).toBeTruthy();
  });

  it('never pulls people into private projects they cannot see', async () => {
    const { owner, dev, id } = await setup();
    const lead = await inviteAndAccept(owner, 'manager');
    const priv = (await post(lead, '/projects', { key: 'SEC', name: 'Secret', visibility: 'private' })).body as ProjectDto;
    const res = await post(lead, `/projects/${priv.id}/tasks`, { title: 'X', assigneeId: id(dev) });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toMatch(/can't see this project/);
  });

  it('lists assignable people: members for members; plus joinable people for leads', async () => {
    const { owner, dev, viewer, project, id } = await setup();
    const extra = await inviteAndAccept(owner, 'member');
    const asLead = (await get(owner, `/projects/${project.id}/assignable`)).body.items as { userId: string; isMember: boolean }[];
    expect(asLead.find((u) => u.userId === id(extra))?.isMember).toBe(false);
    expect(asLead.some((u) => u.userId === id(viewer))).toBe(false);
    const asMember = (await get(dev, `/projects/${project.id}/assignable`)).body.items as { userId: string }[];
    expect(asMember.some((u) => u.userId === id(extra))).toBe(false);
    expect(asMember.some((u) => u.userId === id(dev))).toBe(true);
  });

  it('updates with optimistic concurrency and emails a new assignee', async () => {
    const { owner, dev, project, id } = await setup();
    const t = await createTask(owner, project.id, { title: 'Draft' });
    const a = await patch(owner, t, { title: 'Final', assigneeId: id(dev) });
    expect(a.status).toBe(200);
    expect(a.headers.etag).toBe(`"${a.body.version}"`);
    expect((await patch(owner, t, { title: 'Stale' })).status).toBe(409);
    expect(await emailsTo(dev.body.user.email, 'taskAssigned')).toHaveLength(1);
    expect((await request(app).patch(`${base}/tasks/${t.id}`).set(bearer(owner)).send({ title: 'No etag' })).status).toBe(428);
  });
});

describe('board ordering', () => {
  it('moves cards between neighbours and across columns', async () => {
    const { owner, project } = await setup();
    const [a, b, c] = [
      await createTask(owner, project.id, { title: 'A' }),
      await createTask(owner, project.id, { title: 'B' }),
      await createTask(owner, project.id, { title: 'C' }),
    ];
    // C to the top of To do.
    expect((await move(owner, c, { statusId: 'todo', beforeId: a.id })).status).toBe(200);
    // A between C and B... i.e. after C.
    expect((await move(owner, a, { statusId: 'todo', afterId: c.id })).status).toBe(200);
    // B to In progress.
    const movedB = await move(owner, b, { statusId: 'in_progress' });
    expect(movedB.body.statusCategory).toBe('in_progress');

    const board = (await get(owner, `/projects/${project.id}/board`)).body as { tasks: TaskDto[]; truncated: boolean };
    const col = (s: string) => board.tasks.filter((t) => t.statusId === s).map((t) => t.title);
    expect(col('todo')).toEqual(['C', 'A']);
    expect(col('in_progress')).toEqual(['B']);
    expect(board.truncated).toBe(false);
  });

  it('rejects stale versions and neighbours that are no longer in the column', async () => {
    const { owner, project } = await setup();
    const a = await createTask(owner, project.id, { title: 'A' });
    const b = await createTask(owner, project.id, { title: 'B', statusId: 'in_progress' });
    expect((await move(owner, a, { statusId: 'todo', afterId: b.id })).status).toBe(409);
    expect((await move(owner, a, { statusId: 'nope' })).status).toBe(400);
    expect((await move(owner, a, { statusId: 'in_progress' })).status).toBe(200);
    expect((await move(owner, a, { statusId: 'todo' })).status).toBe(409); // stale version
  });

  it('re-spaces a column when ranks get long, keeping the order and versions', async () => {
    const { owner, project } = await setup();
    const tasks = [];
    for (const title of ['A', 'B', 'C', 'D']) tasks.push(await createTask(owner, project.id, { title }));
    // Simulate years of moves: long ranks, two of them colliding.
    const long = (c: string) => `${'z'.repeat(31)}${c}`;
    const ranks = [long('1'), long('5'), long('5'), long('9')];
    for (const [i, t] of tasks.entries()) await Task.updateOne({ _id: new Types.ObjectId(t.id) }, { $set: { rank: ranks[i] } }).setOptions({ skipTenant: true });

    const [a, b, c, d] = tasks.map((t) => ({ ...t, version: t.version }));
    // Drop A between the two colliding cards (B and C).
    expect((await move(owner, a!, { statusId: 'todo', afterId: b!.id, beforeId: c!.id })).status).toBe(200);

    const board = (await get(owner, `/projects/${project.id}/board`)).body as { tasks: TaskDto[] };
    expect(board.tasks.map((t) => t.title)).toEqual(['B', 'A', 'C', 'D']);
    expect(board.tasks.every((t) => t.rank.length <= 5)).toBe(true);
    // Neighbours were re-ranked without a version bump, so their cached versions still work.
    expect((await move(owner, d!, { statusId: 'in_progress' })).status).toBe(200);
  });

  it('sets and clears completedAt with the done category', async () => {
    const { owner, project } = await setup();
    const t = await createTask(owner, project.id, { title: 'A' });
    const done = (await move(owner, t, { statusId: 'done' })).body as TaskDto;
    expect(done.completedAt).not.toBeNull();
    const reopened = (await move(owner, done, { statusId: 'todo' })).body as TaskDto;
    expect(reopened.completedAt).toBeNull();
  });
});

describe('testing step', () => {
  it('requires an eligible tester other than the assignee to send a task to testing', async () => {
    const { owner, dev, viewer, project, id } = await setup();
    const t = await createTask(owner, project.id, { title: 'Checkout', assigneeId: id(dev), statusId: 'in_progress' });
    const noTester = await move(dev, t, { statusId: 'testing' });
    expect(noTester.status).toBe(400);
    expect(noTester.body.errors[0].path).toBe('testerId');
    expect((await move(dev, t, { statusId: 'testing', testerId: id(dev) })).status).toBe(400);
    expect((await move(dev, t, { statusId: 'testing', testerId: id(viewer) })).status).toBe(400);
    expect((await post(owner, `/projects/${project.id}/tasks`, { title: 'Y', statusId: 'testing' })).status).toBe(400);
  });

  it('runs a full fail-then-pass cycle with emails to the right people', async () => {
    const { owner, dev, qa, project, id } = await setup();
    const t0 = await createTask(owner, project.id, { title: 'Checkout', assigneeId: id(dev), statusId: 'in_progress' });

    // Round 1: dev hands over to qa.
    const sent = await move(dev, t0, { statusId: 'testing', testerId: id(qa), note: 'Try a declined card too' });
    expect(sent.status).toBe(200);
    const t1 = sent.body as TaskDto;
    expect(t1.tester?.id).toBe(id(qa));
    expect(t1.testing).toMatchObject({ round: 1, result: 'pending', note: 'Try a declined card too', sentBy: { id: id(dev) } });
    const requested = await emailsTo(qa.body.user.email, 'testRequested');
    expect(requested).toHaveLength(1);
    expect((requested[0]!.payload as { data: { note: string } }).data.note).toBe('Try a declined card too');

    // The developer cannot sign off their own work.
    expect((await move(dev, t1, { statusId: 'done' })).status).toBe(403);

    // qa fails it back to In progress.
    const failed = (await move(qa, t1, { statusId: 'in_progress', note: 'Declined card shows a blank page' })).body as TaskDto;
    expect(failed.testing).toMatchObject({ round: 1, result: 'failed', resultBy: { id: id(qa) }, note: 'Declined card shows a blank page' });
    const failMail = await emailsTo(dev.body.user.email, 'testFailed');
    expect(failMail).toHaveLength(1);
    expect((failMail[0]!.payload as { data: { note: string } }).data.note).toBe('Declined card shows a blank page');

    // Round 2: the tester is remembered, so no testerId is needed.
    const t2 = (await move(dev, failed, { statusId: 'testing' })).body as TaskDto;
    expect(t2.testing).toMatchObject({ round: 2, result: 'pending' });
    expect(await emailsTo(qa.body.user.email, 'testRequested')).toHaveLength(2);

    // qa passes it.
    const passed = (await move(qa, t2, { statusId: 'done' })).body as TaskDto;
    expect(passed.testing).toMatchObject({ round: 2, result: 'passed' });
    expect(passed.completedAt).not.toBeNull();
  });

  it('lets a project lead finish testing, and requires a tester while in testing', async () => {
    const { owner, dev, qa, project, id } = await setup();
    const t = await createTask(owner, project.id, { title: 'Search', assigneeId: id(dev), statusId: 'in_progress' });
    const inTest = (await move(dev, t, { statusId: 'testing', testerId: id(qa) })).body as TaskDto;

    expect((await patch(owner, inTest, { testerId: null })).status).toBe(400);
    const reassigned = await patch(owner, inTest, { testerId: id(owner) });
    expect(reassigned.status).toBe(200);
    // The owner reassigned to themselves, so no email for that.
    expect(await emailsTo(owner.body.user.email, 'testRequested')).toHaveLength(0);

    expect((await move(owner, reassigned.body, { statusId: 'done' })).status).toBe(200);
  });

  it('lists the tasks waiting for my testing', async () => {
    const { owner, dev, qa, project, id } = await setup();
    const a = await createTask(owner, project.id, { title: 'A', assigneeId: id(dev), statusId: 'in_progress' });
    await createTask(owner, project.id, { title: 'B', assigneeId: id(dev) });
    await move(dev, a, { statusId: 'testing', testerId: id(qa) });
    const mine = (await get(qa, '/tasks?tester=me&statusCategory=testing')).body as { items: TaskDto[] };
    expect(mine.items.map((t) => t.title)).toEqual(['A']);
    const devOpen = (await get(dev, '/tasks?assignee=me&state=open')).body as { items: TaskDto[] };
    expect(devOpen.items.map((t) => t.title).sort()).toEqual(['A', 'B']);
  });
});

describe('subtasks and checklist', () => {
  it('keeps parent counters in step and cascades deletion', async () => {
    const { owner, project } = await setup();
    const parent = await createTask(owner, project.id, { title: 'Parent' });
    const s1 = await createTask(owner, project.id, { title: 'S1', parentTaskId: parent.id });
    await createTask(owner, project.id, { title: 'S2', parentTaskId: parent.id });
    expect((await post(owner, `/projects/${project.id}/tasks`, { title: 'Nested', parentTaskId: s1.id })).status).toBe(400);

    await move(owner, s1, { statusId: 'done' });
    let p = (await get(owner, `/tasks/${parent.id}`)).body as TaskDto;
    expect(p.counts).toMatchObject({ subtasks: 2, subtasksDone: 1 });

    // Subtasks are not cards on the board.
    const board = (await get(owner, `/projects/${project.id}/board`)).body as { tasks: TaskDto[] };
    expect(board.tasks.map((t) => t.title)).toEqual(['Parent']);
    expect(((await get(owner, `/tasks?parentId=${parent.id}`)).body as { items: TaskDto[] }).items.map((t) => t.title)).toEqual(['S1', 'S2']);

    expect((await del(owner, `/tasks/${s1.id}`)).status).toBe(204);
    p = (await get(owner, `/tasks/${parent.id}`)).body as TaskDto;
    expect(p.counts).toMatchObject({ subtasks: 1, subtasksDone: 0 });

    expect((await del(owner, `/tasks/${parent.id}`)).status).toBe(204);
    expect(((await get(owner, `/tasks?projectId=${project.id}`)).body as { items: TaskDto[] }).items).toHaveLength(0);
  });

  it('adds, toggles and removes checklist items', async () => {
    const { owner, dev, project } = await setup();
    const t = await createTask(owner, project.id, { title: 'Release' });
    const added = (await post(dev, `/tasks/${t.id}/checklist`, { text: 'Bump version' })).body as TaskDto;
    const item = added.checklist[0]!;
    const toggled = (await request(app).patch(`${base}/tasks/${t.id}/checklist/${item.id}`).set(bearer(dev)).send({ done: true })).body as TaskDto;
    expect(toggled.counts).toMatchObject({ checklist: 1, checklistDone: 1 });
    const removed = (await del(dev, `/tasks/${t.id}/checklist/${item.id}`)).body as TaskDto;
    expect(removed.checklist).toHaveLength(0);
    expect((await del(dev, `/tasks/${t.id}/checklist/${item.id}`)).status).toBe(404);
  });
});

describe('labels and search', () => {
  it('creates labels, filters by them, and pulls them from tasks on delete', async () => {
    const { owner, project } = await setup();
    const bug = (await post(owner, `/projects/${project.id}/labels`, { name: 'Bug', color: '#dc2626' })).body as { id: string };
    expect((await post(owner, `/projects/${project.id}/labels`, { name: 'bug' })).status).toBe(409);
    const t = await createTask(owner, project.id, { title: 'Broken link', labelIds: [bug.id] });
    await createTask(owner, project.id, { title: 'Other' });

    const filtered = (await get(owner, `/tasks?projectId=${project.id}&labelId=${bug.id}`)).body as { items: TaskDto[] };
    expect(filtered.items.map((x) => x.title)).toEqual(['Broken link']);
    expect(((await get(owner, `/tasks?projectId=${project.id}&q=web-2`)).body as { items: TaskDto[] }).items.map((x) => x.title)).toEqual(['Other']);
    expect(((await get(owner, `/tasks?projectId=${project.id}&q=brok`)).body as { items: TaskDto[] }).items.map((x) => x.key)).toEqual([t.key]);

    expect((await del(owner, `/projects/${project.id}/labels/${bug.id}`)).status).toBe(204);
    expect(((await get(owner, `/tasks/${t.id}`)).body as TaskDto).labelIds).toEqual([]);
  });

  it('rejects labels from another project', async () => {
    const { owner, project } = await setup();
    const other = (await post(owner, '/projects', { key: 'OPS', name: 'Ops' })).body as ProjectDto;
    const foreign = (await post(owner, `/projects/${other.id}/labels`, { name: 'Infra' })).body as { id: string };
    expect((await post(owner, `/projects/${project.id}/tasks`, { title: 'X', labelIds: [foreign.id] })).status).toBe(400);
  });
});

describe('task permissions', () => {
  it('viewers read but cannot write; reporters and leads can delete', async () => {
    const { owner, dev, qa, viewer, project } = await setup();
    expect((await post(viewer, `/projects/${project.id}/tasks`, { title: 'Nope' })).status).toBe(403);
    expect((await get(viewer, `/projects/${project.id}/board`)).status).toBe(200);

    const devTask = await createTask(dev, project.id, { title: 'Dev task' });
    expect((await del(qa, `/tasks/${devTask.id}`)).status).toBe(403);
    expect((await del(dev, `/tasks/${devTask.id}`)).status).toBe(204);
    const other = await createTask(dev, project.id, { title: 'Another' });
    expect((await del(owner, `/tasks/${other.id}`)).status).toBe(204);
  });

  it('hides tasks of private projects and other workspaces (404)', async () => {
    const { owner, dev } = await setup();
    const priv = (await post(owner, '/projects', { key: 'SEC', name: 'Secret', visibility: 'private' })).body as ProjectDto;
    const t = await createTask(owner, priv.id, { title: 'Hidden' });
    expect((await get(dev, `/tasks/${t.id}`)).status).toBe(404);
    expect(((await get(dev, '/tasks')).body as { items: TaskDto[] }).items.map((x) => x.id)).not.toContain(t.id);

    const stranger = await signup();
    expect((await get(stranger, `/tasks/${t.id}`)).status).toBe(404);
    expect((await move(stranger, t, { statusId: 'done' })).status).toBe(404);
  });

  it('archived projects are read-only, and deleting a project hides its tasks', async () => {
    const { owner, project } = await setup();
    const t = await createTask(owner, project.id, { title: 'Before archive' });
    const archived = await request(app).patch(`${base}/projects/${project.id}`).set(bearer(owner)).set('If-Match', `"${project.version}"`).send({ status: 'archived' });
    expect(archived.status).toBe(200);
    expect((await post(owner, `/projects/${project.id}/tasks`, { title: 'After' })).status).toBe(409);
    expect((await move(owner, t, { statusId: 'done' })).status).toBe(409);

    expect((await del(owner, `/projects/${project.id}`)).status).toBe(204);
    expect((await get(owner, `/tasks/${t.id}`)).status).toBe(404);
  });
});
