import { randomBytes } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import {
  ERROR_CODES,
  hasRoleAtLeast,
  WHITEBOARD_LIMITS,
  type CreateWhiteboardInput,
  type ListWhiteboardsQuery,
  type Page,
  type SaveSceneInput,
  type SceneAppState,
  type SceneElement,
  type SearchHitDto,
  type SnapshotReason,
  type WhiteboardDetailDto,
  type WhiteboardDto,
  type WhiteboardFileDto,
  type WhiteboardImageType,
  type WhiteboardSceneDto,
  type WhiteboardSnapshotDto,
} from '@teamtrack/shared';
import { withTransaction } from '../../db/transaction';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors/AppError';
import type { AuthContext } from '../../auth/context';
import type { IBoard } from '../../models/Board';
import type { IBoardSnapshot } from '../../models/BoardSnapshot';
import type { IUser } from '../../models/User';
import { memberRepository, projectRepository } from '../../repositories/projectRepository';
import { userRepository } from '../../repositories/userRepository';
import { recordActivity, type ActivityChange } from '../../services/activity';
import { realtime } from '../../services/realtime';
import { storage, storageKey } from '../../services/storage';
import { logger } from '../../observability/logger';
import { projectsService } from '../projects/projects.service';
import { boardRepository, snapshotRepository, type SnapshotStub } from './boards.repository';
import { decodeScene, EMPTY_SCENE, encodeScene, liveCount, referencedFileIds, restoreElements, sniffImage, type StoredScene } from './boards.scene';

type Access = Awaited<ReturnType<typeof projectsService.access>>;
interface Loaded {
  board: IBoard;
  a: Access;
  /** Members of an active project; archived projects are read-only. */
  canEdit: boolean;
}

/** Retention: the newest KEEP_LATEST snapshots, plus the newest one of each older calendar day (UTC). */
export const KEEP_LATEST = 50;
const HISTORY_LIMIT = 200;
const THUMBNAIL_TTL_SEC = 3600;

export const boardRoom = (id: string) => `board:${id}`;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hex = (id: Types.ObjectId) => id.toHexString();

/* ------------------------------------------------------------------ storage keys */

const boardPrefix = (b: Pick<IBoard, '_id' | 'workspaceId'>) => ['boards', hex(b.workspaceId), hex(b._id)];
const snapshotKey = (b: IBoard, snapshotId: Types.ObjectId) => storageKey(...boardPrefix(b), 'snapshots', `${hex(snapshotId)}.json.gz`);
const fileKey = (b: IBoard, fileId: string) => storageKey(...boardPrefix(b), 'files', fileId);
const thumbnailKey = (b: IBoard) => storageKey(...boardPrefix(b), 'thumbnail.png');

/** Storage cleanup never fails a request: an orphaned object costs bytes, not correctness. */
async function removeQuietly(keys: string[]): Promise<void> {
  const results = await Promise.allSettled(keys.map((k) => storage.remove(k)));
  results.forEach((r, i) => r.status === 'rejected' && logger.warn({ err: r.reason, key: keys[i] }, 'board storage cleanup failed'));
}

/* ------------------------------------------------------------------ guards */

async function loadWithAccess(ctx: AuthContext, id: string | Types.ObjectId): Promise<Loaded> {
  const board = await boardRepository.findById(ctx.workspaceId, id);
  if (!board) throw new NotFoundError('Board');
  try {
    const a = await projectsService.access(ctx, board.projectId);
    return { board, a, canEdit: a.canEdit && a.project.status === 'active' };
  } catch (err) {
    if (err instanceof NotFoundError) throw new NotFoundError('Board');
    throw err;
  }
}

function assertWritable(a: Access): void {
  if (!a.canEdit) throw new ForbiddenError('You can view this board but not change it');
  if (a.project.status === 'archived') throw new ConflictError('This project is archived. Restore it to make changes.');
}

const canDelete = (ctx: AuthContext, l: Loaded) => l.canEdit && (l.a.canManage || l.board.createdBy.equals(ctx.userId));

function sceneConflict(sceneVersion: number): ConflictError {
  return new ConflictError('Someone else saved this board since you loaded it', ERROR_CODES.STALE_VERSION, { sceneVersion });
}

/** Projects the caller can see; null means all (admins). */
async function visibleProjectIds(ctx: AuthContext): Promise<Types.ObjectId[] | null> {
  if (hasRoleAtLeast(ctx.role, 'admin')) return null;
  const memberships = await memberRepository.listForUser(ctx.workspaceId, ctx.userId);
  return projectRepository.visibleIds(ctx.workspaceId, { memberOf: memberships.map((m) => m.projectId), includeWorkspaceVisible: ctx.role !== 'guest' });
}

/* ------------------------------------------------------------------ DTOs */

async function loadUsers(ctx: AuthContext, ids: (Types.ObjectId | null | undefined)[]): Promise<Map<string, IUser>> {
  const unique = new Map<string, Types.ObjectId>();
  for (const id of ids) if (id) unique.set(hex(id), id);
  if (!unique.size) return new Map();
  const users = await userRepository.findByIds(ctx.workspaceId, [...unique.values()]);
  return new Map(users.map((u) => [hex(u._id), u]));
}

const personRef = (users: Map<string, IUser>, id: Types.ObjectId | null) => {
  const u = id && users.get(hex(id));
  return u ? { id: hex(u._id), name: u.name } : null;
};

async function toDtos(ctx: AuthContext, items: { board: IBoard; l: Omit<Loaded, 'board'> }[]): Promise<WhiteboardDto[]> {
  const users = await loadUsers(ctx, items.map((i) => i.board.lastEditedBy));
  return Promise.all(
    items.map(async ({ board: b, l }) => ({
      id: hex(b._id),
      projectId: hex(b.projectId),
      projectName: l.a.project.name,
      title: b.title,
      sceneVersion: b.sceneVersion,
      elementCount: b.elementCount,
      thumbnailUrl: b.thumbnailKey ? await storage.signedUrl(b.thumbnailKey, { ttlSec: THUMBNAIL_TTL_SEC }) : null,
      lastEditedBy: personRef(users, b.lastEditedBy),
      lastEditedAt: b.lastEditedAt.toISOString(),
      createdBy: hex(b.createdBy),
      canEdit: l.canEdit,
      canDelete: canDelete(ctx, { ...l, board: b }),
      createdAt: b.createdAt.toISOString(),
      version: b.version,
    })),
  );
}

const toDto = async (ctx: AuthContext, board: IBoard, l: Loaded) => (await toDtos(ctx, [{ board, l }]))[0]!;

function toSceneDto(scene: StoredScene): WhiteboardSceneDto {
  const files: WhiteboardSceneDto['files'] = {};
  for (const [id, f] of Object.entries(scene.files)) files[id] = { mimeType: f.mimeType };
  return { elements: scene.elements, appState: scene.appState, files };
}

/* ------------------------------------------------------------------ scene persistence */

async function readSnapshot(snap: Pick<IBoardSnapshot, 'storageKey'>): Promise<StoredScene> {
  const body = await storage.get(snap.storageKey);
  if (!body) {
    logger.error({ key: snap.storageKey }, 'board snapshot object missing');
    throw new AppError(503, ERROR_CODES.INTERNAL, 'This board’s drawing is temporarily unavailable. Try again shortly.');
  }
  return decodeScene(body);
}

async function readCurrent(board: IBoard): Promise<StoredScene> {
  if (!board.currentSnapshotId) return EMPTY_SCENE;
  const snap = await snapshotRepository.findById(board.workspaceId, board._id, board.currentSnapshotId);
  if (!snap) {
    logger.error({ boardId: hex(board._id) }, 'board current snapshot missing');
    throw new AppError(503, ERROR_CODES.INTERNAL, 'This board’s drawing is temporarily unavailable. Try again shortly.');
  }
  return readSnapshot(snap);
}

/** Only images uploaded to this board are kept, so a scene can't point at another board's objects. */
function filesFor(board: IBoard, elements: SceneElement[]): StoredScene['files'] {
  const used = referencedFileIds(elements);
  const files: StoredScene['files'] = {};
  for (const f of board.files) if (used.has(f.fileId)) files[f.fileId] = { mimeType: f.mimeType, storageKey: fileKey(board, f.fileId) };
  return files;
}

function pickAppState(s: SceneAppState): SceneAppState {
  return { ...(s.viewBackgroundColor !== undefined ? { viewBackgroundColor: s.viewBackgroundColor } : {}), ...(s.gridSize !== undefined ? { gridSize: s.gridSize } : {}) };
}

/** Snapshots past the retention window (input newest first). */
export function prunable(stubs: SnapshotStub[]): SnapshotStub[] {
  const day = (s: SnapshotStub) => s.createdAt.toISOString().slice(0, 10);
  const covered = new Set(stubs.slice(0, KEEP_LATEST).map(day));
  const out: SnapshotStub[] = [];
  for (const s of stubs.slice(KEEP_LATEST)) {
    if (covered.has(day(s))) out.push(s);
    else covered.add(day(s));
  }
  return out;
}

/**
 * Saves a new snapshot and makes it current if the board is still at `fromSceneVersion`.
 * The object is written first (a failed transaction removes it); retention runs in the same transaction
 * and the pruned objects are deleted after commit.
 */
async function commitSnapshot(
  ctx: AuthContext,
  board: IBoard,
  fromSceneVersion: number,
  scene: StoredScene,
  reason: SnapshotReason,
  alsoInTransaction?: (session: ClientSession) => Promise<void>,
): Promise<IBoard> {
  const body = await encodeScene(scene);
  if (body.length > WHITEBOARD_LIMITS.maxSceneBytes) {
    throw new AppError(413, ERROR_CODES.VALIDATION_FAILED, 'This board is too large to save (over 5 MB compressed). Remove some images or drawings.');
  }
  const snapshotId = new Types.ObjectId();
  const key = snapshotKey(board, snapshotId);
  const elementCount = liveCount(scene.elements);
  await storage.put(key, body, 'application/gzip');

  let pruned: SnapshotStub[] = [];
  let updated: IBoard;
  try {
    updated = await withTransaction(async (session) => {
      const next = await boardRepository.advanceScene(
        ctx.workspaceId,
        board._id,
        fromSceneVersion,
        { currentSnapshotId: snapshotId, elementCount, lastEditedBy: ctx.userId, lastEditedAt: new Date() },
        session,
      );
      if (!next) {
        const now = await boardRepository.findById(ctx.workspaceId, board._id, session);
        if (!now) throw new NotFoundError('Board');
        throw sceneConflict(now.sceneVersion);
      }
      await snapshotRepository.create(
        { _id: snapshotId, workspaceId: ctx.workspaceId, boardId: board._id, sceneVersion: next.sceneVersion, storageKey: key, sizeBytes: body.length, elementCount, reason, createdBy: ctx.userId },
        session,
      );
      pruned = prunable(await snapshotRepository.stubs(ctx.workspaceId, board._id, session));
      await snapshotRepository.deleteMany(ctx.workspaceId, pruned.map((s) => s._id), session);
      await alsoInTransaction?.(session);
      return next;
    });
  } catch (err) {
    await removeQuietly([key]);
    throw err;
  }
  await removeQuietly(pruned.map((s) => s.storageKey));
  return updated;
}

function activity(ctx: AuthContext, board: IBoard, action: string, changes?: ActivityChange[]) {
  return { workspaceId: ctx.workspaceId, projectId: board.projectId, entityType: 'board' as const, entityId: board._id, entityKey: board.title, actorId: ctx.userId, action, ...(changes ? { changes } : {}) };
}

/* ------------------------------------------------------------------ service */

export const boardsService = {
  async list(ctx: AuthContext, q: ListWhiteboardsQuery): Promise<Page<WhiteboardDto>> {
    const projectIds = q.projectId ? [(await projectsService.access(ctx, q.projectId)).project._id] : await visibleProjectIds(ctx);
    const page = await boardRepository.list(ctx.workspaceId, { projectIds, limit: q.limit, cursor: q.cursor });

    // One access check per distinct project; boards of projects that have since gone are skipped.
    const access = new Map<string, Omit<Loaded, 'board'> | null>();
    for (const id of new Set(page.items.map((b) => hex(b.projectId)))) {
      try {
        const a = await projectsService.access(ctx, id);
        access.set(id, { a, canEdit: a.canEdit && a.project.status === 'active' });
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
        access.set(id, null);
      }
    }
    const items = page.items.flatMap((board) => {
      const l = access.get(hex(board.projectId));
      return l ? [{ board, l }] : [];
    });
    return { items: await toDtos(ctx, items), nextCursor: page.nextCursor };
  },

  async get(ctx: AuthContext, id: string): Promise<WhiteboardDetailDto> {
    const l = await loadWithAccess(ctx, id);
    const scene = await readCurrent(l.board);
    return { ...(await toDto(ctx, l.board, l)), scene: toSceneDto(scene) };
  },

  async create(ctx: AuthContext, input: CreateWhiteboardInput): Promise<WhiteboardDto> {
    const a = await projectsService.access(ctx, input.projectId);
    assertWritable(a);
    const board = await withTransaction(async (session) => {
      const created = await boardRepository.create(
        { workspaceId: ctx.workspaceId, projectId: a.project._id, title: input.title, lastEditedBy: ctx.userId, lastEditedAt: new Date(), createdBy: ctx.userId, updatedBy: ctx.userId },
        session,
      );
      await recordActivity(session, activity(ctx, created, 'created'));
      return created;
    });
    return toDto(ctx, board, { board, a, canEdit: true });
  },

  async rename(ctx: AuthContext, id: string, title: string, expectedVersion: number): Promise<WhiteboardDto> {
    const l = await loadWithAccess(ctx, id);
    assertWritable(l.a);
    const updated = await withTransaction(async (session) => {
      const doc = await boardRepository.rename(ctx.workspaceId, l.board._id, expectedVersion, title, ctx.userId, session);
      if (doc.title !== l.board.title) await recordActivity(session, activity(ctx, doc, 'renamed', [{ field: 'title', from: l.board.title, to: doc.title }]));
      return doc;
    });
    return toDto(ctx, updated, l);
  },

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const l = await loadWithAccess(ctx, id);
    assertWritable(l.a);
    if (!canDelete(ctx, l)) throw new ForbiddenError('Only the creator, a project lead or an admin can delete this board');
    await withTransaction(async (session) => {
      if (!(await boardRepository.softDelete(ctx.workspaceId, l.board._id, ctx.userId, session))) throw new NotFoundError('Board');
      await recordActivity(session, activity(ctx, l.board, 'deleted'));
    });
  },

  /** Saves the drawing if `baseVersion` is current; otherwise 409 with the current sceneVersion (the client reconciles and retries). */
  async saveScene(ctx: AuthContext, id: string, input: SaveSceneInput): Promise<WhiteboardDto> {
    const l = await loadWithAccess(ctx, id);
    assertWritable(l.a);
    if (l.board.sceneVersion !== input.baseVersion) throw sceneConflict(l.board.sceneVersion);
    const scene: StoredScene = { elements: input.elements, appState: pickAppState(input.appState), files: filesFor(l.board, input.elements) };
    const updated = await commitSnapshot(ctx, l.board, input.baseVersion, scene, input.reason);
    return toDto(ctx, updated, l);
  },

  async snapshots(ctx: AuthContext, id: string): Promise<WhiteboardSnapshotDto[]> {
    const l = await loadWithAccess(ctx, id);
    const snaps = await snapshotRepository.listForBoard(ctx.workspaceId, l.board._id, HISTORY_LIMIT);
    const users = await loadUsers(ctx, snaps.map((s) => s.createdBy));
    return snaps.map((s) => ({
      id: hex(s._id),
      sceneVersion: s.sceneVersion,
      elementCount: s.elementCount,
      sizeBytes: s.sizeBytes,
      reason: s.reason,
      createdBy: personRef(users, s.createdBy),
      createdAt: s.createdAt.toISOString(),
      current: !!l.board.currentSnapshotId?.equals(s._id),
    }));
  },

  /**
   * Makes an old snapshot current again, as a new snapshot (history is never rewritten). Element versions
   * are raised above the live ones so open editors adopt the restored state when they merge.
   */
  async restore(ctx: AuthContext, id: string, snapshotId: string): Promise<WhiteboardDetailDto> {
    const l = await loadWithAccess(ctx, id);
    assertWritable(l.a);
    const snap = await snapshotRepository.findById(ctx.workspaceId, l.board._id, snapshotId);
    if (!snap) throw new NotFoundError('Snapshot');
    const [target, current] = await Promise.all([readSnapshot(snap), readCurrent(l.board)]);
    const elements = restoreElements(current.elements, target.elements);
    const scene: StoredScene = { elements, appState: target.appState, files: filesFor(l.board, elements) };
    const updated = await commitSnapshot(ctx, l.board, l.board.sceneVersion, scene, 'restore', (session) =>
      recordActivity(session, activity(ctx, l.board, 'restored', [{ field: 'version', from: `v${l.board.sceneVersion}`, to: `v${snap.sceneVersion}` }])),
    );
    realtime.toRoom(boardRoom(id), 'board:scene', { boardId: id, elements, from: 'server' });
    return { ...(await toDto(ctx, updated, l)), scene: toSceneDto(scene) };
  },

  async uploadFile(ctx: AuthContext, id: string, body: Buffer): Promise<WhiteboardFileDto> {
    const l = await loadWithAccess(ctx, id);
    assertWritable(l.a);
    if (!body.length) throw new ValidationError([{ path: '(body)', message: 'The file is empty' }]);
    const mimeType = sniffImage(body);
    if (!mimeType) throw new AppError(415, ERROR_CODES.VALIDATION_FAILED, 'Only PNG, JPEG, GIF and WebP images can be added to a board');
    const fileId = randomBytes(16).toString('hex');
    const key = fileKey(l.board, fileId);
    await storage.put(key, body, mimeType);
    const added = await boardRepository.addFile(ctx.workspaceId, l.board._id, { fileId, mimeType, sizeBytes: body.length, createdBy: ctx.userId, createdAt: new Date() });
    if (!added) {
      await removeQuietly([key]);
      throw new ConflictError(`A board can hold at most ${WHITEBOARD_LIMITS.maxFilesPerBoard} images`);
    }
    return { fileId, mimeType, url: await storage.signedUrl(key) };
  },

  /** Signed URL of an image on the board (only ids uploaded to this board resolve). */
  async fileUrl(ctx: AuthContext, id: string, fileId: string): Promise<string> {
    const l = await loadWithAccess(ctx, id);
    if (!l.board.files.some((f) => f.fileId === fileId)) throw new NotFoundError('File');
    return storage.signedUrl(fileKey(l.board, fileId));
  },

  /** Image bytes through the API, for the canvas (no CORS rules needed on the bucket). */
  async fileContent(ctx: AuthContext, id: string, fileId: string): Promise<{ body: Buffer; mimeType: WhiteboardImageType }> {
    const l = await loadWithAccess(ctx, id);
    const file = l.board.files.find((f) => f.fileId === fileId);
    if (!file) throw new NotFoundError('File');
    const body = await storage.get(fileKey(l.board, fileId));
    if (!body) throw new NotFoundError('File');
    return { body, mimeType: file.mimeType };
  },

  async setThumbnail(ctx: AuthContext, id: string, body: Buffer): Promise<void> {
    const l = await loadWithAccess(ctx, id);
    assertWritable(l.a);
    if (sniffImage(body) !== 'image/png') throw new AppError(415, ERROR_CODES.VALIDATION_FAILED, 'The thumbnail must be a PNG image');
    const key = thumbnailKey(l.board);
    await storage.put(key, body, 'image/png');
    if (!(await boardRepository.setThumbnail(ctx.workspaceId, l.board._id, key))) throw new NotFoundError('Board');
  },

  /* ---- used by register.ts (entity resolver, search, sockets) */

  /** Board + access, or null if it doesn't exist or the caller can't see it. */
  async resolve(ctx: AuthContext, id: string | Types.ObjectId): Promise<Loaded | null> {
    try {
      return await loadWithAccess(ctx, id);
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  },

  async search(ctx: AuthContext, q: string, limit: number): Promise<SearchHitDto[]> {
    const boards = await boardRepository.search(ctx.workspaceId, await visibleProjectIds(ctx), new RegExp(escapeRegex(q), 'i'), limit);
    const names = new Map<string, string | null>();
    for (const id of new Set(boards.map((b) => hex(b.projectId)))) names.set(id, (await projectRepository.findById(ctx.workspaceId, id))?.name ?? null);
    return boards.flatMap((b) => {
      const projectName = names.get(hex(b.projectId));
      return projectName ? [{ type: 'board' as const, id: hex(b._id), title: b.title, subtitle: projectName, path: `/boards/${hex(b._id)}` }] : [];
    });
  },
};
