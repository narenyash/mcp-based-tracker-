import { objectIdSchema, type BoardPresence } from '@teamtrack/shared';
import type { AuthContext } from '../../auth/context';
import { userRepository } from '../../repositories/userRepository';
import { onProjectEvict, onSocketConnection, type AppServer, type AppSocket, type FetchedSocket } from '../../services/realtime';
import { logger } from '../../observability/logger';
import { boardRoom, boardsService } from './boards.service';

/*
 * Live whiteboard collaboration in `board:<id>` rooms. The server relays, it does not persist: clients
 * autosave through PUT /boards/:id/scene and its sceneVersion check settles races.
 *  - join: access check, then presence (distinct people in the room) to everyone in it.
 *  - scene: changed elements from editors who joined, relayed to the rest of the room.
 *  - pointer: cursor positions, at most POINTER_RATE per second per socket (extra ones are dropped).
 * Edit rights are cached per socket and re-checked every RECHECK_MS, so a removed member stops
 * reaching others within that window without a database read per message. Listening is cut off when
 * the membership change happens: evictFromProject re-checks every board of that project the socket joined.
 */

const RECHECK_MS = 30_000;
const POINTER_RATE = 20;
/** Per-message caps (the transport's maxHttpBufferSize is usually the tighter one). */
const MAX_RELAY_ELEMENTS = 1000;
const MAX_RELAY_BYTES = 512 * 1024;

interface Joined {
  projectId: string;
  canEdit: boolean;
  checkedAt: number;
  pending?: Promise<boolean> | undefined;
}

interface SocketState {
  userId: string;
  name: string;
  boards: Map<string, Joined>;
  pointer: { windowStart: number; count: number };
}

/** Per-socket state, keyed by socket id (this instance only, like the rooms themselves). */
const states = new Map<string, SocketState>();

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isBoardId = (v: unknown): v is string => objectIdSchema.safeParse(v).success;
const isElement = (e: unknown) => isRecord(e) && typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 64 && typeof e.version === 'number';

async function broadcastPresence(io: AppServer, boardId: string): Promise<void> {
  const sockets = await io.in(boardRoom(boardId)).fetchSockets();
  const users = new Map<string, string>();
  for (const s of sockets) {
    const st = states.get(s.id);
    if (st) users.set(st.userId, st.name);
  }
  const payload: BoardPresence = { boardId, users: [...users].map(([id, name]) => ({ id, name })) };
  io.to(boardRoom(boardId)).emit('board:presence', payload);
}

/** Re-checks the socket's boards in `projectId` now; ones it can no longer see are left. */
async function evict(socket: FetchedSocket, projectId: string, io: AppServer): Promise<void> {
  const state = states.get(socket.id);
  if (!state) return;
  for (const [boardId, j] of state.boards) {
    if (j.projectId !== projectId) continue;
    const l = await boardsService.resolve(socket.data.ctx, boardId);
    j.canEdit = !!l?.canEdit;
    j.checkedAt = Date.now();
    if (l) continue;
    state.boards.delete(boardId);
    socket.leave(boardRoom(boardId));
    await broadcastPresence(io, boardId);
  }
}

/** Cached edit right; a stale entry is re-checked once, shared by every message waiting on it (keeps order). */
function canEdit(ctx: AuthContext, socket: AppSocket, boardId: string, j: Joined): boolean | Promise<boolean> {
  if (Date.now() - j.checkedAt < RECHECK_MS) return j.canEdit;
  j.pending ??= boardsService
    .resolve(ctx, boardId)
    .then((l) => {
      j.canEdit = !!l?.canEdit;
      j.checkedAt = Date.now();
      if (!l) void socket.leave(boardRoom(boardId));
      return j.canEdit;
    })
    .catch((err: unknown) => {
      logger.warn({ err, boardId }, 'board access re-check failed');
      return false;
    })
    .finally(() => {
      j.pending = undefined;
    });
  return j.pending;
}

function attach(socket: AppSocket, io: AppServer): void {
  const { ctx } = socket.data;
  const state: SocketState = { userId: ctx.userId.toHexString(), name: '', boards: new Map(), pointer: { windowStart: 0, count: 0 } };
  states.set(socket.id, state);

  socket.on('board:join', async (boardId, ack) => {
    const reply = typeof ack === 'function' ? ack : () => undefined;
    if (!isBoardId(boardId)) return reply({ ok: false });
    try {
      const l = await boardsService.resolve(ctx, boardId);
      if (!l) return reply({ ok: false });
      if (!state.name) state.name = (await userRepository.findById(ctx.workspaceId, ctx.userId))?.name ?? 'Someone';
      state.boards.set(boardId, { projectId: l.board.projectId.toHexString(), canEdit: l.canEdit, checkedAt: Date.now() });
      await socket.join(boardRoom(boardId));
      reply({ ok: true });
      await broadcastPresence(io, boardId);
    } catch (err) {
      logger.warn({ err, boardId }, 'board:join failed');
      reply({ ok: false });
    }
  });

  socket.on('board:leave', (boardId) => {
    if (typeof boardId !== 'string' || !state.boards.delete(boardId)) return;
    void socket.leave(boardRoom(boardId));
    void broadcastPresence(io, boardId).catch((err: unknown) => logger.warn({ err, boardId }, 'board presence failed'));
  });

  socket.on('board:scene', async (e) => {
    if (!isRecord(e) || !isBoardId(e.boardId) || !Array.isArray(e.elements)) return;
    const { boardId, elements } = e as { boardId: string; elements: unknown[] };
    const joined = state.boards.get(boardId);
    if (!joined || !socket.rooms.has(boardRoom(boardId))) return;
    if (elements.length > MAX_RELAY_ELEMENTS || !elements.every(isElement)) return;
    if (JSON.stringify(elements).length > MAX_RELAY_BYTES) return;
    if (!(await canEdit(ctx, socket, boardId, joined))) return;
    socket.to(boardRoom(boardId)).emit('board:scene', { boardId, elements, from: socket.id });
  });

  socket.on('board:pointer', (e) => {
    if (!isRecord(e) || !isBoardId(e.boardId)) return;
    const { boardId, x, y } = e as { boardId: string; x: unknown; y: unknown };
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!state.boards.has(boardId)) return;
    const now = Date.now();
    if (now - state.pointer.windowStart >= 1000) state.pointer = { windowStart: now, count: 0 };
    if (++state.pointer.count > POINTER_RATE) return;
    socket.to(boardRoom(boardId)).emit('board:pointer', { boardId, userId: state.userId, name: state.name, x, y });
  });

  socket.on('disconnect', () => {
    states.delete(socket.id);
    for (const boardId of state.boards.keys()) {
      void broadcastPresence(io, boardId).catch((err: unknown) => logger.warn({ err, boardId }, 'board presence failed'));
    }
  });
}

export function registerBoardSockets(): void {
  onSocketConnection(attach);
  onProjectEvict(evict);
}
