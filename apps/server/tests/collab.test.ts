import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import type { ActivityDto, AttachmentDto, CommentDto, MentionableUserDto, Page, ProjectDto, TaskDto } from '@teamtrack/shared';
import { app, bearer, inviteAndAccept, signup, useTestDb, type TestSession } from './helpers';
import { Notification, Outbox, Task } from '../src/models';
import { Activity } from '../src/models/Activity';
import { Attachment } from '../src/models/Attachment';
import { withTransaction } from '../src/db/transaction';
import { recordActivity } from '../src/services/activity';
import { storage } from '../src/services/storage';
import { processOne } from '../src/workers/outboxWorker';

useTestDb();
afterEach(() => {
  vi.restoreAllMocks();
});

const base = '/api/v1';
const get = (s: TestSession, url: string) => request(app).get(base + url).set(bearer(s));
const post = (s: TestSession, url: string, body: object = {}) => request(app).post(base + url).set(bearer(s)).send(body);
const del = (s: TestSession, url: string) => request(app).delete(base + url).set(bearer(s));
const patchComment = (s: TestSession, c: Pick<CommentDto, 'id' | 'version'>, body: string) =>
  request(app).patch(`${base}/comments/${c.id}`).set(bearer(s)).set('If-Match', `"${c.version}"`).send({ body });
const drain = async () => {
  while (await processOne());
};
const anyTenant = { skipTenant: true };

/** Owner (project lead) + project "WEB" with two members (dev, qa) and a viewer. */
async function setup() {
  const owner = await signup();
  const [dev, qa, viewer] = [await inviteAndAccept(owner, 'member'), await inviteAndAccept(owner, 'member'), await inviteAndAccept(owner, 'member')];
  const project = (await post(owner, '/projects', { key: 'WEB', name: 'Website' })).body as ProjectDto;
  for (const [s, role] of [[dev, 'member'], [qa, 'member'], [viewer, 'viewer']] as const) {
    await post(owner, `/projects/${project.id}/members`, { userId: s.body.user.id, role });
  }
  await drain(); // invite emails
  const task = (await post(owner, `/projects/${project.id}/tasks`, { title: 'Login page', assigneeId: dev.body.user.id })).body as TaskDto;
  await drain(); // assignment notice
  return { owner, dev, qa, viewer, project, task, id: (s: TestSession) => s.body.user.id };
}

const comment = (s: TestSession, t: TaskDto, body: string, parentId?: string) =>
  post(s, '/comments', { entityType: 'task', entityId: t.id, body, ...(parentId ? { parentId } : {}) });
const thread = async (s: TestSession, t: TaskDto, query = '') => (await get(s, `/comments?entityType=task&entityId=${t.id}${query}`)).body as Page<CommentDto>;
const token = (s: TestSession) => `@[${s.body.user.name}](${s.body.user.id})`;

const upload = (s: TestSession, t: TaskDto, fileName: string, body: Buffer, type = 'application/octet-stream') =>
  request(app)
    .post(`${base}/attachments?entityType=task&entityId=${t.id}&fileName=${encodeURIComponent(fileName)}`)
    .set(bearer(s))
    .set('Content-Type', type)
    .send(body);

/* Minimal image headers: enough bytes for the dimension parsers. */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdr, Buffer.alloc(4)]);
}
function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(16);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
function webpLossless(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8L', 12, 'latin1');
  b[20] = 0x2f;
  b.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  return b;
}

describe('comments', () => {
  it('creates, lists oldest first with keyset pagination, edits with If-Match, and deletes', async () => {
    const { dev, task } = await setup();
    const first = (await comment(dev, task, 'First')).body as CommentDto;
    expect(first).toMatchObject({ body: 'First', author: { id: dev.body.user.id, name: dev.body.user.name }, parentId: null, deleted: false, canEdit: true, canDelete: true });
    for (const b of ['Second', 'Third']) expect((await comment(dev, task, b)).status).toBe(201);

    const page1 = await thread(dev, task, '&limit=2');
    expect(page1.items.map((c) => c.body)).toEqual(['First', 'Second']);
    const page2 = await thread(dev, task, `&limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`);
    expect(page2.items.map((c) => c.body)).toEqual(['Third']);
    expect(page2.nextCursor).toBeNull();

    expect((await request(app).patch(`${base}/comments/${first.id}`).set(bearer(dev)).send({ body: 'x' })).status).toBe(428);
    const edited = await patchComment(dev, first, 'First (edited)');
    expect(edited.status).toBe(200);
    expect(edited.headers.etag).toBe(`"${first.version + 1}"`);
    expect(edited.body.editedAt).not.toBeNull();
    expect((await patchComment(dev, first, 'stale')).status).toBe(409);

    expect((await del(dev, `/comments/${first.id}`)).status).toBe(204);
    expect((await thread(dev, task)).items.map((c) => c.body)).toEqual(['Second', 'Third']);
    expect((await patchComment(dev, edited.body as CommentDto, 'gone')).status).toBe(404);
  });

  it('validates bodies', async () => {
    const { dev, task } = await setup();
    expect((await comment(dev, task, '   ')).status).toBe(400);
    expect((await comment(dev, task, 'x'.repeat(10_001))).status).toBe(400);
    expect((await post(dev, '/comments', { entityType: 'task', entityId: task.id })).status).toBe(400);
    expect((await post(dev, '/comments', { entityType: 'nope', entityId: task.id, body: 'hi' })).status).toBe(400);
  });

  it('lets viewers read but not post; hides private projects (404); only the author edits; leads moderate', async () => {
    const { owner, dev, qa, viewer, task } = await setup();
    const c = (await comment(dev, task, 'Mine')).body as CommentDto;

    expect((await thread(viewer, task)).items).toHaveLength(1);
    expect((await comment(viewer, task, 'Can I?')).status).toBe(403);
    expect((await thread(viewer, task)).items[0]).toMatchObject({ canEdit: false, canDelete: false });

    expect((await patchComment(qa, c, 'hijack')).status).toBe(403);
    expect((await del(qa, `/comments/${c.id}`)).status).toBe(403);
    // The owner leads the project, so they can moderate but still not edit someone else's words.
    expect((await thread(owner, task)).items[0]).toMatchObject({ canEdit: false, canDelete: true });
    expect((await patchComment(owner, c, 'edit')).status).toBe(403);
    expect((await del(owner, `/comments/${c.id}`)).status).toBe(204);

    const priv = (await post(owner, '/projects', { key: 'SEC', name: 'Secret', visibility: 'private' })).body as ProjectDto;
    const secret = (await post(owner, `/projects/${priv.id}/tasks`, { title: 'Hidden' })).body as TaskDto;
    const sc = (await comment(owner, secret, 'Top secret')).body as CommentDto;
    expect((await get(dev, `/comments?entityType=task&entityId=${secret.id}`)).status).toBe(404);
    expect((await comment(dev, secret, 'Let me in')).status).toBe(404);
    expect((await del(dev, `/comments/${sc.id}`)).status).toBe(404);
    expect((await get(dev, `/comments?entityType=task&entityId=${new Types.ObjectId().toHexString()}`)).status).toBe(404);

    // Another workspace can't see it either.
    const other = await signup({ workspaceName: 'Other' });
    expect((await get(other, `/comments?entityType=task&entityId=${task.id}`)).status).toBe(404);
  });

  it('supports one level of replies, and keeps deleted parents as placeholders while they have replies', async () => {
    const { owner, dev, task } = await setup();
    const parent = (await comment(dev, task, 'Question')).body as CommentDto;
    const reply = (await comment(owner, task, 'Answer', parent.id)).body as CommentDto;
    expect(reply.parentId).toBe(parent.id);
    expect((await comment(dev, task, 'Nested', reply.id)).status).toBe(400);

    const otherTask = (await post(owner, `/projects/${task.projectId}/tasks`, { title: 'Other' })).body as TaskDto;
    expect((await comment(dev, otherTask, 'Wrong thread', parent.id)).status).toBe(400);
    expect((await comment(dev, task, 'Unknown parent', new Types.ObjectId().toHexString())).status).toBe(400);

    expect((await thread(dev, task)).items[0]!.replyCount).toBe(1);
    expect((await del(dev, `/comments/${parent.id}`)).status).toBe(204);
    const items = (await thread(dev, task)).items;
    expect(items.map((c) => [c.deleted, c.body, c.author])).toEqual([
      [true, '', null],
      [false, 'Answer', { id: owner.body.user.id, name: owner.body.user.name }],
    ]);
    // Replying to a deleted comment isn't possible.
    expect((await comment(dev, task, 'Late reply', parent.id)).status).toBe(400);

    // Once its last reply goes, the placeholder goes too.
    expect((await del(owner, `/comments/${reply.id}`)).status).toBe(204);
    expect((await thread(dev, task)).items).toHaveLength(0);
  });

  it('notifies mentioned people and other participants (never the author), and drops invalid mentions', async () => {
    const { owner, dev, qa, viewer, project, task, id } = await setup();
    const guest = await inviteAndAccept(owner, 'guest'); // can't see the project
    const body = `Hey ${token(qa)} and ${token(viewer)}, see ${token(guest)} @[Ghost](${'f'.repeat(24)}) and @[Not you](${dev.body.user.id})`;
    const res = await comment(dev, task, body);
    expect(res.status).toBe(201);
    const c = res.body as CommentDto;
    // Valid tokens keep the user's real name; invalid ones become plain text.
    expect(c.body).toBe(`Hey ${token(qa)} and ${token(viewer)}, see @${guest.body.user.name} @Ghost and ${token(dev)}`);

    await drain();
    const rows = await Notification.find({ entityId: new Types.ObjectId(task.id), type: { $in: ['mentioned', 'comment_added'] } })
      .setOptions(anyTenant)
      .lean();
    const byUser = Object.fromEntries(rows.map((n) => [n.userId.toHexString(), n.type]));
    // owner = reporter (participant), qa + viewer = mentioned; dev = author (and the assignee) gets nothing.
    expect(byUser).toEqual({ [id(qa)]: 'mentioned', [id(viewer)]: 'mentioned', [id(owner)]: 'comment_added' });
    const mention = rows.find((n) => n.userId.toHexString() === id(qa))!;
    expect(mention).toMatchObject({ title: `${dev.body.user.name} mentioned you on WEB-1`, path: `/projects/${project.id}?task=${task.id}` });
    expect(mention.note).toContain(`Hey @${qa.body.user.name} and @${viewer.body.user.name}`);
    expect(mention.note).not.toContain('](');

    // Editing notifies only people newly mentioned; retries/duplicates don't double up.
    const edited = await patchComment(dev, c, `${c.body} ${token(owner)} ${token(qa)}`);
    expect(edited.status).toBe(200);
    await drain();
    const after = await Notification.find({ entityId: new Types.ObjectId(task.id), type: 'mentioned' }).setOptions(anyTenant).lean();
    expect(after.map((n) => n.userId.toHexString()).sort()).toEqual([id(owner), id(qa), id(viewer)].sort());
    expect(await Outbox.countDocuments({ type: 'notify', dedupeKey: { $regex: `^comment:${c.id}:` } })).toBe(4);
  });

  it('lists people who can be mentioned', async () => {
    const { owner, dev, qa, task } = await setup();
    const guest = await inviteAndAccept(owner, 'guest');
    const all = (await get(dev, `/mentionable?entityType=task&entityId=${task.id}`)).body.items as MentionableUserDto[];
    const ids = all.map((u) => u.id);
    expect(ids).toContain(qa.body.user.id);
    expect(ids).toContain(owner.body.user.id);
    expect(ids).not.toContain(dev.body.user.id); // not yourself
    expect(ids).not.toContain(guest.body.user.id); // can't see the project
    const filtered = (await get(dev, `/mentionable?entityType=task&entityId=${task.id}&q=own`)).body.items as MentionableUserDto[];
    expect(filtered.map((u) => u.id)).toEqual([owner.body.user.id]);
  });

  it('records a commented activity entry', async () => {
    const { dev, task } = await setup();
    await comment(dev, task, 'Hello');
    const feed = (await get(dev, `/activity?entityType=task&entityId=${task.id}`)).body as Page<ActivityDto>;
    expect(feed.items[0]).toMatchObject({ action: 'commented', entityKey: 'WEB-1', actor: { id: dev.body.user.id } });
  });
});

describe('attachments', () => {
  it('stores images with their dimensions and serves them through short-lived signed URLs', async () => {
    const { dev, viewer, task } = await setup();
    const cases: [string, Buffer, string, { width: number; height: number }][] = [
      ['shot.png', png(640, 480), 'image/png', { width: 640, height: 480 }],
      ['anim.gif', gif(32, 16), 'image/gif', { width: 32, height: 16 }],
      ['photo.jpeg', jpeg(1024, 768), 'image/jpeg', { width: 1024, height: 768 }],
      ['art.webp', webpLossless(300, 200), 'image/webp', { width: 300, height: 200 }],
    ];
    for (const [name, bytes, mimeType, image] of cases) {
      const res = await upload(dev, task, name, bytes, 'application/octet-stream');
      expect(res.status, name).toBe(201);
      expect(res.body).toMatchObject({ fileName: name, mimeType, image, sizeBytes: bytes.length, uploader: { id: dev.body.user.id }, canDelete: true });
    }

    const list = (await get(viewer, `/attachments?entityType=task&entityId=${task.id}`)).body.items as AttachmentDto[];
    expect(list.map((a) => a.fileName)).toEqual(['shot.png', 'anim.gif', 'photo.jpeg', 'art.webp']);
    expect(list[0]!.canDelete).toBe(false);

    const file = await request(app).get(list[0]!.url);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(file.body as Buffer, png(640, 480))).toBe(0);
    const download = await request(app).get(list[0]!.downloadUrl);
    expect(download.headers['content-disposition']).toContain("filename*=UTF-8''shot.png");
    // A tampered signature is refused.
    expect((await request(app).get(`${list[0]!.url.slice(0, -2)}xx`)).status).toBe(404);

    const doc = await Attachment.findOne({ fileName: 'shot.png' }).setOptions(anyTenant).lean();
    expect(doc!.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(doc!.storageKey).toContain(`/teamtrack/attachments/task/${task.id}/`);
  });

  it('identifies files by their bytes: rejects executables and SVG whatever they are called', async () => {
    const { dev, task } = await setup();
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]);
    expect((await upload(dev, task, 'invoice.pdf', exe, 'application/pdf')).status).toBe(415);
    expect((await upload(dev, task, 'photo.png', exe, 'image/png')).status).toBe(415);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await upload(dev, task, 'logo.svg', svg, 'image/svg+xml')).status).toBe(415);
    expect((await upload(dev, task, 'logo.txt', svg, 'text/plain')).status).toBe(415);
    expect((await upload(dev, task, 'page.txt', Buffer.from('<?xml version="1.0"?><svg/>'), 'text/plain')).status).toBe(415);
    // A PNG signature with a truncated header is damaged, not an image.
    expect((await upload(dev, task, 'broken.png', png(1, 1).subarray(0, 12), 'image/png')).status).toBe(400);
    expect(await Attachment.countDocuments({}).setOptions(anyTenant)).toBe(0);

    // Real text and PDFs are fine; the name's extension is corrected to match the content.
    const csv = await upload(dev, task, 'data.csv', Buffer.from('a,b\n1,2\n'), 'text/csv');
    expect(csv.body).toMatchObject({ mimeType: 'text/csv', image: null, fileName: 'data.csv' });
    const pdf = await upload(dev, task, '../../etc/report', Buffer.from('%PDF-1.7\n%...'), 'application/pdf');
    expect(pdf.body).toMatchObject({ mimeType: 'application/pdf', fileName: 'report.pdf' });
    const disguised = await upload(dev, task, 'notes.txt', png(10, 10), 'text/plain');
    expect(disguised.body).toMatchObject({ mimeType: 'image/png', fileName: 'notes.txt.png' });
  });

  it('enforces the size limit, the per-entity limit, and write access', async () => {
    const { dev, viewer, task } = await setup();
    const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
    expect((await upload(dev, task, 'big.txt', tooBig, 'text/plain')).status).toBe(413);
    expect((await upload(dev, task, 'empty.txt', Buffer.alloc(0), 'text/plain')).status).toBe(400);
    expect((await upload(viewer, task, 'shot.png', png(1, 1))).status).toBe(403);
    expect((await request(app).post(`${base}/attachments?entityType=task&entityId=${task.id}`).set(bearer(dev)).send(png(1, 1))).status).toBe(400);

    const docs = Array.from({ length: 50 }, (_, i) => ({
      workspaceId: new Types.ObjectId(dev.body.workspace.id),
      projectId: new Types.ObjectId(task.projectId),
      entityType: 'task',
      entityId: new Types.ObjectId(task.id),
      uploaderId: new Types.ObjectId(dev.body.user.id),
      storageKey: `seed/${i}`,
      fileName: `f${i}.txt`,
      mimeType: 'text/plain',
      sizeBytes: 1,
      checksumSha256: 'a'.repeat(64),
    }));
    await Attachment.insertMany(docs);
    expect((await upload(dev, task, 'one-more.png', png(1, 1))).status).toBe(409);
  });

  it('lets the uploader or a lead delete, soft-deletes the record and removes the object', async () => {
    const { owner, dev, qa, task } = await setup();
    const a = (await upload(dev, task, 'shot.png', png(2, 2))).body as AttachmentDto;
    const b = (await upload(dev, task, 'other.png', png(3, 3))).body as AttachmentDto;
    const doc = await Attachment.findById(a.id).setOptions(anyTenant).lean();
    expect(await storage.head(doc!.storageKey)).not.toBeNull();

    expect((await del(qa, `/attachments/${a.id}`)).status).toBe(403);
    expect((await del(dev, `/attachments/${a.id}`)).status).toBe(204);
    expect((await del(owner, `/attachments/${b.id}`)).status).toBe(204);
    expect((await del(dev, `/attachments/${a.id}`)).status).toBe(404);

    expect(await storage.head(doc!.storageKey)).toBeNull();
    expect(await Attachment.countDocuments({ _id: doc!._id, deletedAt: { $ne: null } }).setOptions({ ...anyTenant, withDeleted: true })).toBe(1);
    expect((await get(dev, `/attachments?entityType=task&entityId=${task.id}`)).body.items).toHaveLength(0);

    const feed = (await get(dev, `/activity?entityType=task&entityId=${task.id}`)).body as Page<ActivityDto>;
    expect(feed.items.slice(0, 4).map((e) => [e.action, e.changes[0]])).toEqual([
      ['removed_attachment', { field: 'file', from: 'other.png', to: null }],
      ['removed_attachment', { field: 'file', from: 'shot.png', to: null }],
      ['attached', { field: 'file', from: null, to: 'other.png' }],
      ['attached', { field: 'file', from: null, to: 'shot.png' }],
    ]);
  });

  it('removes the stored object when the record cannot be saved', async () => {
    const { dev, task } = await setup();
    const before = await Attachment.countDocuments({}).setOptions(anyTenant);
    const removeSpy = vi.spyOn(storage, 'remove');
    vi.spyOn(Attachment, 'create').mockRejectedValueOnce(new Error('disk full'));
    expect((await upload(dev, task, 'shot.png', png(4, 4))).status).toBe(500);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(await storage.head(removeSpy.mock.calls[0]![0])).toBeNull();
    expect(await Attachment.countDocuments({}).setOptions(anyTenant)).toBe(before);
  });
});

describe('activity', () => {
  it('records task changes with readable values, inside the business transaction', async () => {
    const { owner, dev, qa, task } = await setup();
    const updated = await request(app)
      .patch(`${base}/tasks/${task.id}`)
      .set(bearer(owner))
      .set('If-Match', `"${task.version}"`)
      .send({ title: 'Login screen', assigneeId: qa.body.user.id, priority: 'high' });
    expect(updated.status).toBe(200);
    const moved = await request(app)
      .patch(`${base}/tasks/${task.id}/move`)
      .set(bearer(qa))
      .set('If-Match', `"${(updated.body as TaskDto).version}"`)
      .send({ statusId: 'in_progress' });
    expect(moved.status).toBe(200);

    const feed = (await get(dev, `/activity?entityType=task&entityId=${task.id}`)).body as Page<ActivityDto>;
    expect(feed.items.map((e) => e.action)).toEqual(['moved', 'updated', 'created']);
    const [move, update, create] = feed.items;
    expect(move).toMatchObject({ actor: { id: qa.body.user.id }, entityKey: 'WEB-1', changes: [{ field: 'status', from: 'To do', to: 'In progress' }] });
    expect(update!.changes).toEqual(
      expect.arrayContaining([
        { field: 'title', from: 'Login page', to: 'Login screen' },
        { field: 'priority', from: 'None', to: 'High' },
        { field: 'assignee', from: dev.body.user.name, to: qa.body.user.name },
      ]),
    );
    expect(create!.changes).toEqual([
      { field: 'status', from: null, to: 'To do' },
      { field: 'assignee', from: null, to: dev.body.user.name },
    ]);
  });

  it('writes nothing when the transaction aborts', async () => {
    const { owner, dev, project } = await setup();
    const before = await Activity.countDocuments({}).setOptions(anyTenant);
    // The outbox write comes after the activity entry in the create transaction; failing it aborts both.
    vi.spyOn(Outbox, 'bulkWrite').mockRejectedValueOnce(new Error('outbox down'));
    const res = await post(owner, `/projects/${project.id}/tasks`, { title: 'Doomed', assigneeId: dev.body.user.id });
    expect(res.status).toBe(500);
    expect(await Task.countDocuments({ title: 'Doomed' }).setOptions(anyTenant)).toBe(0);
    expect(await Activity.countDocuments({}).setOptions(anyTenant)).toBe(before);

    // And directly: an entry recorded with a session rolls back with it.
    const entry = {
      workspaceId: new Types.ObjectId(owner.body.workspace.id),
      projectId: new Types.ObjectId(project.id),
      entityType: 'task' as const,
      entityId: new Types.ObjectId(),
      entityKey: 'WEB-99',
      actorId: new Types.ObjectId(owner.body.user.id),
      action: 'updated',
    };
    await expect(
      withTransaction(async (session) => {
        await recordActivity(session, entry);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await Activity.countDocuments({ entityKey: 'WEB-99' }).setOptions(anyTenant)).toBe(0);
    await recordActivity(null, entry);
    expect(await Activity.countDocuments({ entityKey: 'WEB-99' }).setOptions(anyTenant)).toBe(1);
  });

  it('is append-only', async () => {
    const { owner } = await setup();
    await expect(Activity.updateMany({ workspaceId: new Types.ObjectId(owner.body.workspace.id) }, { $set: { action: 'forged' } })).rejects.toThrow('append-only');
  });

  it('paginates newest first, per entity and per project, with access checks', async () => {
    const { owner, dev, viewer, project, task } = await setup();
    for (const text of ['a', 'b', 'c']) await comment(dev, task, text);

    const page1 = (await get(viewer, `/activity?entityType=task&entityId=${task.id}&limit=2`)).body as Page<ActivityDto>;
    expect(page1.items.map((e) => e.action)).toEqual(['commented', 'commented']);
    const page2 = (await get(viewer, `/activity?entityType=task&entityId=${task.id}&limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`)).body as Page<ActivityDto>;
    expect(page2.items.map((e) => e.action)).toEqual(['commented', 'created']);
    expect(page2.nextCursor).toBeNull();
    const ids = [...page1.items, ...page2.items].map((e) => e.id);
    expect(new Set(ids).size).toBe(4);

    const second = (await post(owner, `/projects/${project.id}/tasks`, { title: 'Second' })).body as TaskDto;
    const projectFeed = (await get(viewer, `/activity?projectId=${project.id}&limit=50`)).body as Page<ActivityDto>;
    expect(projectFeed.items[0]).toMatchObject({ entityId: second.id, action: 'created', entityKey: 'WEB-2' });
    expect(projectFeed.items).toHaveLength(5);

    expect((await get(viewer, `/activity?projectId=${project.id}&entityType=task&entityId=${task.id}`)).status).toBe(400);
    expect((await get(viewer, '/activity')).status).toBe(400);
    const priv = (await post(owner, '/projects', { key: 'SEC', name: 'Secret', visibility: 'private' })).body as ProjectDto;
    expect((await get(dev, `/activity?projectId=${priv.id}`)).status).toBe(404);
  });
});
