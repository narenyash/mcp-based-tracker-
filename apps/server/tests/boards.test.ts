import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { io as connect, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  Page,
  ProjectDto,
  ServerToClientEvents,
  WhiteboardDetailDto,
  WhiteboardDto,
  WhiteboardFileDto,
  WhiteboardSnapshotDto,
} from '@teamtrack/shared';
import { app, bearer, inviteAndAccept, signup, useTestDb, type TestSession } from './helpers';
import { BoardSnapshot } from '../src/models/BoardSnapshot';
import { storage } from '../src/services/storage';
import { attachRealtime, closeRealtime, evictFromProject } from '../src/services/realtime';
import { oneSceneSaveAtATime } from '../src/modules/boards/boards.routes';
import { MAX_INFLATED_BYTES } from '../src/modules/boards/boards.scene';
import { EventEmitter } from 'node:events';
import { KEEP_LATEST } from '../src/modules/boards/boards.service';

useTestDb();

const base = '/api/v1';
const get = (s: TestSession, url: string) => request(app).get(base + url).set(bearer(s));
const post = (s: TestSession, url: string, body: object = {}) => request(app).post(base + url).set(bearer(s)).send(body);
const put = (s: TestSession, url: string, body: object) => request(app).put(base + url).set(bearer(s)).send(body);
const patch = (s: TestSession, url: string, body: object, version?: number) => {
  const r = request(app).patch(base + url).set(bearer(s));
  return (version === undefined ? r : r.set('If-Match', `"${version}"`)).send(body);
};
const del = (s: TestSession, url: string) => request(app).delete(base + url).set(bearer(s));
const upload = (s: TestSession, url: string, body: Buffer, type: string) => request(app).post(base + url).set(bearer(s)).set('Content-Type', type).send(body);

const el = (id: string, version = 1, extra: Record<string, unknown> = {}) => ({ id, version, type: 'rectangle', x: 0, y: 0, isDeleted: false, ...extra });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg')]);

async function setup() {
  const owner = await signup();
  const member = await inviteAndAccept(owner, 'member');
  const member2 = await inviteAndAccept(owner, 'member');
  const viewer = await inviteAndAccept(owner, 'member');
  const outsider = await inviteAndAccept(owner, 'member');
  const project = (await post(owner, '/projects', { key: 'WEB', name: 'Website' })).body as ProjectDto;
  const secret = (await post(owner, '/projects', { key: 'SEC', name: 'Secret', visibility: 'private' })).body as ProjectDto;
  for (const [s, role] of [[member, 'member'], [member2, 'member'], [viewer, 'viewer']] as const) {
    expect((await post(owner, `/projects/${project.id}/members`, { userId: s.body.user.id, role })).status).toBeLessThan(300);
  }
  return { owner, member, member2, viewer, outsider, project, secret };
}

async function createBoard(s: TestSession, projectId: string, title = 'Sketch'): Promise<WhiteboardDto> {
  const res = await post(s, '/boards', { projectId, title });
  if (res.status !== 201) throw new Error(`create failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as WhiteboardDto;
}

async function save(s: TestSession, id: string, elements: object[], baseVersion: number) {
  return put(s, `/boards/${id}/scene`, { elements, appState: { viewBackgroundColor: '#ffffff', gridSize: 20 }, baseVersion });
}

describe('whiteboards: CRUD and permissions', () => {
  it('members create, viewers read only, private projects stay hidden', async () => {
    const { owner, member, viewer, outsider, project, secret } = await setup();
    const res = await post(member, '/boards', { projectId: project.id, title: '  Architecture  ' });
    expect(res.status).toBe(201);
    expect(res.headers.etag).toBe(`"${res.body.version}"`);
    const board = res.body as WhiteboardDto;
    expect(board).toMatchObject({ title: 'Architecture', projectName: 'Website', sceneVersion: 0, elementCount: 0, thumbnailUrl: null, canEdit: true, canDelete: true });
    expect(board.lastEditedBy).toEqual({ id: member.body.user.id, name: 'member person' });

    expect((await post(viewer, '/boards', { projectId: project.id, title: 'Nope' })).status).toBe(403);
    expect((await post(member, '/boards', { projectId: project.id, title: '' })).status).toBe(400);

    const asViewer = (await get(viewer, `/boards/${board.id}`)).body as WhiteboardDetailDto;
    expect(asViewer).toMatchObject({ id: board.id, canEdit: false, canDelete: false, scene: { elements: [], appState: {}, files: {} } });
    expect((await save(viewer, board.id, [el('a')], 0)).status).toBe(403);
    expect((await patch(viewer, `/boards/${board.id}`, { title: 'x' }, board.version)).status).toBe(403);
    expect((await upload(viewer, `/boards/${board.id}/files`, PNG, 'image/png')).status).toBe(403);

    // Workspace-visible project: a non-member sees it read-only. Private project: 404 everywhere.
    expect((await get(outsider, `/boards/${board.id}`)).body.canEdit).toBe(false);
    const hidden = await createBoard(owner, secret.id, 'Secret plan');
    expect((await get(outsider, `/boards/${hidden.id}`)).status).toBe(404);
    expect((await save(outsider, hidden.id, [el('a')], 0)).status).toBe(404);
    expect((await post(outsider, '/boards', { projectId: secret.id, title: 'x' })).status).toBe(404);
    expect((await get(outsider, `/boards?projectId=${secret.id}`)).status).toBe(404);

    const mine = (await get(outsider, '/boards')).body as Page<WhiteboardDto>;
    expect(mine.items.map((b) => b.id)).toEqual([board.id]);
    const all = (await get(owner, '/boards')).body as Page<WhiteboardDto>;
    expect(all.items.map((b) => b.id).sort()).toEqual([board.id, hidden.id].sort());
    const filtered = (await get(owner, `/boards?projectId=${project.id}`)).body as Page<WhiteboardDto>;
    expect(filtered.items.map((b) => b.id)).toEqual([board.id]);
  });

  it('renames with If-Match, and only the creator, a lead or an admin can delete', async () => {
    const { owner, member, member2, project } = await setup();
    const board = await createBoard(member, project.id);
    const url = `/boards/${board.id}`;
    expect((await patch(member, url, { title: 'Renamed' })).status).toBe(428);
    const renamed = await patch(member2, url, { title: 'Renamed' }, board.version);
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ title: 'Renamed', version: board.version + 1 });
    expect((await patch(member, url, { title: 'Stale' }, board.version)).status).toBe(409);

    // Autosaves don't touch the metadata version, so a rename after a save still applies.
    expect((await save(member, board.id, [el('a')], 0)).status).toBe(200);
    expect((await patch(member, url, { title: 'After save' }, renamed.body.version)).status).toBe(200);

    expect((await get(member2, url)).body.canDelete).toBe(false);
    expect((await del(member2, url)).status).toBe(403);
    expect((await del(owner, url)).status).toBe(204);
    expect((await get(member, url)).status).toBe(404);
    expect((await get(owner, '/boards')).body.items).toHaveLength(0);
  });

  it('archived projects make boards read-only', async () => {
    const { owner, member, project } = await setup();
    const board = await createBoard(member, project.id);
    expect((await patch(owner, `/projects/${project.id}`, { status: 'archived' }, project.version)).status).toBe(200);
    expect((await get(member, `/boards/${board.id}`)).body.canEdit).toBe(false);
    expect((await save(member, board.id, [el('a')], 0)).status).toBe(409);
  });
});

describe('whiteboards: scenes, history and restore', () => {
  it('saves with a version check, returns the scene inline, and restores old snapshots', async () => {
    const { member, member2, project } = await setup();
    const board = await createBoard(member, project.id);

    const first = await save(member, board.id, [el('a'), el('b')], 0);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ sceneVersion: 1, elementCount: 2 });

    // A second editor still at version 0 is told the current version, then reconciles and retries.
    const stale = await save(member2, board.id, [el('c')], 0);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'STALE_VERSION', sceneVersion: 1 });

    const second = await save(member2, board.id, [el('a'), el('b', 2, { isDeleted: true }), el('c')], 1);
    expect(second.body).toMatchObject({ sceneVersion: 2, elementCount: 2 });

    const detail = (await get(member, `/boards/${board.id}`)).body as WhiteboardDetailDto;
    expect(detail.sceneVersion).toBe(2);
    expect(detail.scene.elements.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(detail.scene.appState).toEqual({ viewBackgroundColor: '#ffffff', gridSize: 20 });
    expect(detail.lastEditedBy?.id).toBe(member2.body.user.id);

    const history = (await get(member, `/boards/${board.id}/snapshots`)).body.items as WhiteboardSnapshotDto[];
    expect(history.map((h) => [h.sceneVersion, h.reason, h.current])).toEqual([
      [2, 'autosave', true],
      [1, 'autosave', false],
    ]);
    expect(history[0]!.createdBy?.id).toBe(member2.body.user.id);

    const restored = await post(member, `/boards/${board.id}/snapshots/${history[1]!.id}/restore`);
    expect(restored.status).toBe(200);
    const r = restored.body as WhiteboardDetailDto;
    expect(r).toMatchObject({ sceneVersion: 3, elementCount: 2 });
    const byId = new Map(r.scene.elements.map((e) => [e.id, e]));
    // Restored elements outrank the live ones (so open editors adopt them); c is now a tombstone.
    expect(byId.get('a')).toMatchObject({ version: 2, isDeleted: false });
    expect(byId.get('b')).toMatchObject({ version: 3, isDeleted: false });
    expect(byId.get('c')).toMatchObject({ version: 2, isDeleted: true });
    expect(((await get(member, `/boards/${board.id}/snapshots`)).body.items as WhiteboardSnapshotDto[])[0]).toMatchObject({ sceneVersion: 3, reason: 'restore', current: true });
    expect((await post(member, `/boards/${board.id}/snapshots/${board.id}/restore`)).status).toBe(404);
  });

  it('accepts gzipped scenes and validates element shape', async () => {
    const { member, project } = await setup();
    const board = await createBoard(member, project.id);
    const body = gzipSync(JSON.stringify({ elements: [el('a'), el('b')], baseVersion: 0 }));
    const res = await request(app).put(`${base}/boards/${board.id}/scene`).set(bearer(member)).set('Content-Type', 'application/gzip').send(body);
    expect(res.status).toBe(200);
    expect(res.body.elementCount).toBe(2);

    const bad = await request(app).put(`${base}/boards/${board.id}/scene`).set(bearer(member)).set('Content-Type', 'application/gzip').send(Buffer.from('not gzip'));
    expect(bad.status).toBe(400);
    expect((await save(member, board.id, [el('a'), el('a')], 1)).status).toBe(400);
    expect((await save(member, board.id, [{ version: 1 }], 1)).status).toBe(400);
    expect((await save(member, board.id, [{ id: 'x', version: 'one' }], 1)).status).toBe(400);
    expect((await put(member, `/boards/${board.id}/scene`, { elements: [] })).status).toBe(400);
  });

  it(`keeps the latest ${KEEP_LATEST} snapshots plus one per older day, and deletes pruned objects`, async () => {
    const { member, project } = await setup();
    const board = await createBoard(member, project.id);
    let v = 0;
    const saveNext = async () => {
      const res = await save(member, board.id, [el('a', v + 1)], v);
      expect(res.status).toBe(200);
      v = res.body.sceneVersion as number;
    };
    for (let i = 0; i < 4; i++) await saveNext();

    // v1 three days ago; v2 and v3 two days ago (only the newer, v3, should survive); v4 today.
    const day = (n: number) => new Date(Date.now() - n * 86_400_000);
    for (const [sceneVersion, at] of [[1, day(3)], [2, day(2)], [3, new Date(day(2).getTime() + 60_000)]] as const) {
      await BoardSnapshot.collection.updateOne({ boardId: { $exists: true }, sceneVersion }, { $set: { createdAt: at } });
    }
    const keyOf = async (sceneVersion: number) => (await BoardSnapshot.findOne({ workspaceId: { $exists: true }, sceneVersion }).lean())!.storageKey;
    const [k2, k4] = [await keyOf(2), await keyOf(4)];

    for (let i = 0; i < KEEP_LATEST; i++) await saveNext();
    expect(v).toBe(KEEP_LATEST + 4);
    const kept = (await BoardSnapshot.find({ workspaceId: { $exists: true } }).sort({ sceneVersion: -1 }).lean()).map((s) => s.sceneVersion);
    expect(kept).toHaveLength(KEEP_LATEST + 2);
    expect(kept.slice(0, KEEP_LATEST)).toEqual(Array.from({ length: KEEP_LATEST }, (_, i) => v - i));
    expect(kept.slice(KEEP_LATEST)).toEqual([3, 1]);
    expect(await storage.head(k2)).toBeNull();
    expect(await storage.head(k4)).toBeNull();
    expect((await get(member, `/boards/${board.id}`)).body.scene.elements[0].version).toBe(v);
  });
});

describe('whiteboards: images and thumbnails', () => {
  it('checks magic bytes, serves files through signed URLs, and lists them with the scene', async () => {
    const { member, viewer, project } = await setup();
    const board = await createBoard(member, project.id);

    const res = await upload(member, `/boards/${board.id}/files`, PNG, 'image/png');
    expect(res.status).toBe(201);
    const file = res.body as WhiteboardFileDto;
    expect(file).toMatchObject({ mimeType: 'image/png' });
    expect(file.fileId).toMatch(/^[a-f\d]{32}$/);

    // The declared type is ignored: bytes decide.
    expect((await upload(member, `/boards/${board.id}/files`, Buffer.from('<svg onload=alert(1)>'), 'image/png')).status).toBe(415);
    expect((await upload(member, `/boards/${board.id}/files`, JPEG, 'image/png')).body.mimeType).toBe('image/jpeg');
    expect((await upload(member, `/boards/${board.id}/files`, Buffer.alloc(6 * 1024 * 1024, 1), 'image/png')).status).toBe(413);

    const redirect = await get(viewer, `/boards/${board.id}/files/${file.fileId}`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toMatch(/^\/api\/v1\/files\//);
    const signed = await request(app).get(redirect.headers.location as string).buffer(true);
    expect(signed.status).toBe(200);
    expect(signed.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(signed.body as Buffer, PNG)).toBe(0);

    const content = await get(viewer, `/boards/${board.id}/files/${file.fileId}/content`).buffer(true);
    expect(content.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(content.body as Buffer, PNG)).toBe(0);
    expect((await get(viewer, `/boards/${board.id}/files/${'0'.repeat(32)}`)).status).toBe(404);
    expect((await get(viewer, `/boards/${board.id}/files/..%2Fsecret`)).status).toBe(400);

    // Only files of this board referenced by live image elements are recorded with the snapshot.
    const image = el('img', 1, { type: 'image', fileId: file.fileId });
    const ghost = el('ghost', 1, { type: 'image', fileId: 'f'.repeat(32) });
    expect((await save(member, board.id, [image, ghost], 0)).status).toBe(200);
    expect((await get(viewer, `/boards/${board.id}`)).body.scene.files).toEqual({ [file.fileId]: { mimeType: 'image/png' } });
  });

  it('stores a PNG thumbnail for the grid', async () => {
    const { member, viewer, project } = await setup();
    const board = await createBoard(member, project.id);
    const url = `${base}/boards/${board.id}/thumbnail`;
    expect((await request(app).put(url).set(bearer(member)).set('Content-Type', 'image/jpeg').send(JPEG)).status).toBe(415);
    expect((await request(app).put(url).set(bearer(viewer)).set('Content-Type', 'image/png').send(PNG)).status).toBe(403);
    expect((await request(app).put(url).set(bearer(member)).set('Content-Type', 'image/png').send(PNG)).status).toBe(204);
    const listed = ((await get(viewer, '/boards')).body as Page<WhiteboardDto>).items[0]!;
    expect(listed.thumbnailUrl).toMatch(/^\/api\/v1\/files\//);
    expect((await request(app).get(listed.thumbnailUrl!)).status).toBe(200);
  });
});

describe('whiteboards: realtime', () => {
  let server: Server;
  let url: string;
  const sockets: Socket[] = [];
  type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

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

  function open(token: string): Promise<ClientSocket> {
    const s: ClientSocket = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    sockets.push(s);
    return new Promise((resolve, reject) => {
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  }
  const next = <E extends keyof ServerToClientEvents>(s: ClientSocket, event: E, until: (p: Parameters<ServerToClientEvents[E]>[0]) => boolean = () => true, ms = 3000) =>
    new Promise<Parameters<ServerToClientEvents[E]>[0]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${event} within ${ms}ms`)), ms);
      const handler = (payload: Parameters<ServerToClientEvents[E]>[0]) => {
        if (!until(payload)) return;
        clearTimeout(timer);
        s.off(event, handler as never);
        resolve(payload);
      };
      s.on(event, handler as never);
    });
  const quiet = (ms = 250) => new Promise((r) => setTimeout(r, ms));

  it('refuses unauthenticated sockets and boards the caller cannot see', async () => {
    const { owner, outsider, secret } = await setup();
    await expect(open('not-a-token')).rejects.toThrow('unauthorized');
    const hidden = await createBoard(owner, secret.id);
    const s = await open(outsider.token);
    expect(await s.emitWithAck('board:join', hidden.id)).toEqual({ ok: false });
    expect(await s.emitWithAck('board:join', 'nope')).toEqual({ ok: false });
  });

  it('relays scenes and pointers to the rest of the room, lists presence, and ignores viewers’ edits', async () => {
    const { owner, member, viewer, project } = await setup();
    const board = await createBoard(member, project.id);
    const [ownerSocket, memberSocket, viewerSocket] = [await open(owner.token), await open(member.token), await open(viewer.token)];

    expect(await ownerSocket.emitWithAck('board:join', board.id)).toEqual({ ok: true });
    const bothPresent = next(ownerSocket, 'board:presence', (p) => p.users.length === 2);
    expect(await memberSocket.emitWithAck('board:join', board.id)).toEqual({ ok: true });
    const presence = await bothPresent;
    expect(presence.boardId).toBe(board.id);
    expect(presence.users.map((u) => u.id).sort()).toEqual([owner.body.user.id, member.body.user.id].sort());
    expect(presence.users.find((u) => u.id === owner.body.user.id)?.name).toBe('Owner');

    // A socket that hasn't joined can't push into the room.
    let leaked = false;
    ownerSocket.on('board:scene', (e) => e.elements.some((x) => (x as { id: string }).id === 'sneaky') && (leaked = true));
    viewerSocket.emit('board:scene', { boardId: board.id, elements: [el('sneaky')] });

    let echoed = false;
    memberSocket.on('board:scene', () => (echoed = true));
    const relayed = next(ownerSocket, 'board:scene');
    memberSocket.emit('board:scene', { boardId: board.id, elements: [el('a', 3)] });
    expect(await relayed).toEqual({ boardId: board.id, elements: [el('a', 3)], from: memberSocket.id });

    const pointer = next(ownerSocket, 'board:pointer');
    memberSocket.emit('board:pointer', { boardId: board.id, x: 10, y: 20 });
    expect(await pointer).toEqual({ boardId: board.id, userId: member.body.user.id, name: 'member person', x: 10, y: 20 });

    // Viewers may join (to watch) but their scene messages go nowhere.
    expect(await viewerSocket.emitWithAck('board:join', board.id)).toEqual({ ok: true });
    viewerSocket.emit('board:scene', { boardId: board.id, elements: [el('sneaky')] });
    await quiet();
    expect(leaked).toBe(false);
    expect(echoed).toBe(false);

    // Leaving updates everyone's presence.
    const afterLeave = next(ownerSocket, 'board:presence', (p) => p.users.length === 2 && !p.users.some((u) => u.id === member.body.user.id));
    memberSocket.emit('board:leave', board.id);
    await afterLeave;
  });

  it('drops pointer floods beyond 20 per second', async () => {
    const { owner, member, project } = await setup();
    const board = await createBoard(member, project.id);
    const [ownerSocket, memberSocket] = [await open(owner.token), await open(member.token)];
    for (const s of [ownerSocket, memberSocket]) expect(await s.emitWithAck('board:join', board.id)).toEqual({ ok: true });
    let received = 0;
    ownerSocket.on('board:pointer', () => received++);
    for (let i = 0; i < 50; i++) memberSocket.emit('board:pointer', { boardId: board.id, x: i, y: i });
    await quiet(400);
    expect(received).toBe(20);
  });

  it('pushes restores to open editors', async () => {
    const { owner, member, project } = await setup();
    const board = await createBoard(member, project.id);
    await save(member, board.id, [el('a')], 0);
    await save(member, board.id, [el('a', 2), el('b')], 1);
    const ownerSocket = await open(owner.token);
    expect(await ownerSocket.emitWithAck('board:join', board.id)).toEqual({ ok: true });
    const history = (await get(member, `/boards/${board.id}/snapshots`)).body.items as WhiteboardSnapshotDto[];
    const pushed = next(ownerSocket, 'board:scene');
    await post(member, `/boards/${board.id}/snapshots/${history[1]!.id}/restore`);
    const e = await pushed;
    expect(e.from).toBe('server');
    expect(e.elements.map((x) => (x as { id: string; isDeleted: boolean }).isDeleted)).toEqual([false, true]);
  });

  it('relays scene messages up to the relay cap without dropping the socket', async () => {
    const { owner, member, project } = await setup();
    const board = await createBoard(member, project.id);
    const [ownerSocket, memberSocket] = [await open(owner.token), await open(member.token)];
    for (const s of [ownerSocket, memberSocket]) expect(await s.emitWithAck('board:join', board.id)).toEqual({ ok: true });
    // ~300 KB: far over the old 10 KB transport cap, under the 512 KB relay cap.
    const elements = Array.from({ length: 300 }, (_, i) => el(`big${i}`, 1, { text: 'x'.repeat(1000) }));
    const relayed = next(ownerSocket, 'board:scene');
    memberSocket.emit('board:scene', { boardId: board.id, elements });
    expect((await relayed).elements).toHaveLength(300);
    expect(memberSocket.connected).toBe(true);
  });

  it('evicts removed members from board rooms so they stop receiving the scene', async () => {
    // A private project: once removed, a member can't see it at all (public projects stay readable).
    const { owner, member, member2, secret: project } = await setup();
    for (const s of [member, member2]) expect((await post(owner, `/projects/${project.id}/members`, { userId: s.body.user.id, role: 'member' })).status).toBeLessThan(300);
    const board = await createBoard(owner, project.id);
    const [ownerSocket, memberSocket, member2Socket] = [await open(owner.token), await open(member.token), await open(member2.token)];
    for (const s of [ownerSocket, memberSocket, member2Socket]) expect(await s.emitWithAck('board:join', board.id)).toEqual({ ok: true });

    expect((await del(owner, `/projects/${project.id}/members/${member.body.user.id}`)).status).toBe(204);
    const presence = next(ownerSocket, 'board:presence', (p) => !p.users.some((u) => u.id === member.body.user.id));
    await evictFromProject(owner.body.workspace.id, project.id, [member.body.user.id, member2.body.user.id]);
    await presence;

    let leaked = false;
    memberSocket.on('board:scene', () => (leaked = true));
    const stillMember = next(member2Socket, 'board:scene');
    ownerSocket.emit('board:scene', { boardId: board.id, elements: [el('after', 2)] });
    await stillMember;
    await quiet();
    expect(leaked).toBe(false);
    // And it can't simply re-join.
    expect(await memberSocket.emitWithAck('board:join', board.id)).toEqual({ ok: false });
  });
});

describe('whiteboards: scene save limits', () => {
  it('rejects gzip bodies that inflate past the cap with 413', async () => {
    const { member, project } = await setup();
    const board = await createBoard(member, project.id);
    const bomb = gzipSync(`{"elements":[],"baseVersion":0,"pad":"${'a'.repeat(MAX_INFLATED_BYTES)}"}`);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const res = await request(app).put(`${base}/boards/${board.id}/scene`).set(bearer(member)).set('Content-Type', 'application/gzip').send(bomb);
    expect(res.status).toBe(413);
    expect(res.body.title ?? res.body.message ?? res.body.detail).toBeTruthy();
  });

  it('allows one scene save in flight per user', () => {
    const fakeRes = () => Object.assign(new EventEmitter(), { setHeader: () => undefined });
    const req = (userId: string) => ({ auth: { userId: { toHexString: () => userId } } }) as never;
    const results: unknown[] = [];
    const first = fakeRes();
    oneSceneSaveAtATime(req('u1'), first as never, (err?: unknown) => results.push(err));
    oneSceneSaveAtATime(req('u1'), fakeRes() as never, (err?: unknown) => results.push(err));
    oneSceneSaveAtATime(req('u2'), fakeRes() as never, (err?: unknown) => results.push(err));
    expect(results[0]).toBeUndefined();
    expect(results[1]).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(results[2]).toBeUndefined();
    first.emit('close');
    oneSceneSaveAtATime(req('u1'), fakeRes() as never, (err?: unknown) => results.push(err));
    expect(results[3]).toBeUndefined();
  });
});
