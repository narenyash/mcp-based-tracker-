import type { Server as HttpServer } from 'node:http';
import { Types } from 'mongoose';
import { Server, type Socket } from 'socket.io';
import { objectIdSchema, type ClientToServerEvents, type ServerToClientEvents, type TaskChangedEvent } from '@teamtrack/shared';
import { env } from '../config/env';
import type { AuthContext } from '../auth/context';
import { verifyAccessToken } from '../auth/tokens';
import { userRepository } from '../repositories/userRepository';
import { sessionRepository } from '../repositories/sessionRepository';
import { getContext } from '../observability/requestContext';
import { logger } from '../observability/logger';

/*
 * Live updates over Socket.io.
 *  - The handshake carries the access token; the socket is closed when that token expires and the client
 *    reconnects with its refreshed one, so a revoked session can't keep listening.
 *  - Rooms: user:<id> (notifications) and project:<id> (board changes, joined after an access check).
 *  - Payloads carry ids only; clients refetch through the REST API and its permission checks.
 * One instance keeps rooms in memory. Running several instances needs a shared adapter (e.g. @socket.io/mongo-adapter).
 */

interface SocketData {
  ctx: AuthContext;
}
type AppServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export type { AppServer, AppSocket };

/**
 * Extension point for modules that need their own socket events (e.g. whiteboards). Register at import
 * time (from the module's register.ts); handlers run for every authenticated connection.
 */
type ConnectionHandler = (socket: AppSocket, io: AppServer) => void;
const connectionHandlers: ConnectionHandler[] = [];
export function onSocketConnection(handler: ConnectionHandler): void {
  connectionHandlers.push(handler);
}

/** Checks the caller may see a project. Injected to keep this module free of the projects service. */
export type ProjectAccessCheck = (ctx: AuthContext, projectId: string) => Promise<boolean>;

/** A connected socket as returned by fetchSockets (local or, with a shared adapter, remote). */
export type FetchedSocket = Awaited<ReturnType<AppServer['fetchSockets']>>[number];

/**
 * Called by evictFromProject for each affected socket after its context is refreshed, so modules with
 * their own rooms (e.g. whiteboards) can drop the ones in that project the socket may no longer see.
 */
type EvictHandler = (socket: FetchedSocket, projectId: string, io: AppServer) => Promise<void>;
const evictHandlers: EvictHandler[] = [];
export function onProjectEvict(handler: EvictHandler): void {
  evictHandlers.push(handler);
}

let io: AppServer | null = null;
let canSeeProject: ProjectAccessCheck | null = null;

const userRoom = (id: string) => `user:${id}`;
const projectRoom = (id: string) => `project:${id}`;

/**
 * Inbound packet cap. Whiteboard scene relays are the largest messages (boards.realtime.ts caps them at
 * 512 KB of JSON), so this sits just above that; anything bigger closes the socket.
 */
const MAX_PACKET_BYTES = 600 * 1024;

export function attachRealtime(server: HttpServer, projectAccess: ProjectAccessCheck): AppServer {
  canSeeProject = projectAccess;
  io = new Server(server, {
    path: '/socket.io',
    cors: { origin: env.CLIENT_URL, credentials: true },
    serveClient: false,
    maxHttpBufferSize: MAX_PACKET_BYTES,
  });

  io.use(async (socket: AppSocket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: unknown }).token;
      if (typeof token !== 'string') throw new Error('missing token');
      const claims = verifyAccessToken(token);
      // A signed-out or revoked session can't open a socket with a still-valid token.
      const [user, live] = await Promise.all([
        userRepository.findForAuth(claims.workspaceId, claims.userId),
        sessionRepository.isSessionActive(claims.sessionId, claims.workspaceId),
      ]);
      if (!user || user.status !== 'active' || !live) throw new Error('inactive');
      socket.data.ctx = { userId: user._id, workspaceId: user.workspaceId, role: user.role, sessionId: claims.sessionId };
      // Close the socket when the token expires; the client reconnects with a fresh one.
      const ttl = claims.expiresAt.getTime() - Date.now();
      const timer = setTimeout(() => socket.disconnect(true), Math.max(ttl, 0));
      socket.on('disconnect', () => clearTimeout(timer));
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: AppSocket) => {
    const { ctx } = socket.data;
    void socket.join(userRoom(ctx.userId.toHexString()));

    socket.on('project:join', async (projectId, ack) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      if (!objectIdSchema.safeParse(projectId).success) return reply({ ok: false });
      try {
        if (!(await projectAccess(ctx, projectId))) return reply({ ok: false });
        await socket.join(projectRoom(projectId));
        reply({ ok: true });
      } catch (err) {
        logger.warn({ err, projectId }, 'project:join failed');
        reply({ ok: false });
      }
    });

    socket.on('project:leave', (projectId) => {
      if (typeof projectId === 'string') void socket.leave(projectRoom(projectId));
    });

    for (const handler of connectionHandlers) handler(socket, io!);
  });

  return io;
}

export async function closeRealtime(): Promise<void> {
  if (!io) return;
  const server = io;
  io = null;
  canSeeProject = null;
  await new Promise<void>((resolve) => void server.close(() => resolve()));
}

/**
 * Re-checks access for sockets after a membership change (member removed, project archived or deleted,
 * user deactivated or demoted) and makes them leave rooms they can no longer see: the project room, and
 * through onProjectEvict handlers any board rooms of the project. Pass `userIds` to limit it to the
 * people affected; without it every socket in the workspace is re-checked. Never throws (call after
 * commit); a no-op before attachRealtime (tests).
 */
export async function evictFromProject(workspaceId: string, projectId: string, userIds?: string[]): Promise<void> {
  if (!io || !canSeeProject) return;
  const server = io;
  const check = canSeeProject;
  try {
    const sockets = userIds ? (userIds.length ? await io.in(userIds.map(userRoom)).fetchSockets() : []) : await io.fetchSockets();
    await Promise.all(
      sockets
        .filter((s) => s.data.ctx?.workspaceId.toHexString() === workspaceId)
        .map(async (s) => {
          try {
            const { ctx } = s.data;
            // The role may have changed too; refresh it in place (handlers hold this same object).
            const user = await userRepository.findForAuth(ctx.workspaceId, ctx.userId);
            if (!user || user.status !== 'active') return void s.disconnect(true);
            ctx.role = user.role;
            if (s.rooms.has(projectRoom(projectId)) && !(await check(ctx, projectId))) s.leave(projectRoom(projectId));
            for (const handler of evictHandlers) await handler(s, projectId, server);
          } catch (err) {
            // Fail closed: a socket whose access can't be confirmed is dropped; it reconnects and re-joins.
            logger.warn({ err, socketId: s.id, projectId }, 'realtime eviction check failed');
            s.disconnect(true);
          }
        }),
    );
  } catch (err) {
    logger.warn({ err, projectId }, 'realtime eviction failed');
  }
}

/** The socket that made the current API request, so it isn't sent its own change back. */
function originSocket(): string | undefined {
  return getContext()?.socketId;
}

export const realtime = {
  /** Closes every live socket of a user (signed out everywhere, suspended). Clients reconnect only with a valid session. */
  disconnectUser(userId: string): void {
    io?.in(userRoom(userId)).disconnectSockets(true);
  },

  toUser<E extends keyof ServerToClientEvents>(userId: string, event: E, ...args: Parameters<ServerToClientEvents[E]>): void {
    io?.to(userRoom(userId)).emit(event, ...args);
  },

  /** Emits to everyone viewing a project except the socket that made the change. Call after commit. */
  toProject<E extends keyof ServerToClientEvents>(projectId: string, event: E, ...args: Parameters<ServerToClientEvents[E]>): void {
    if (!io) return;
    const origin = originSocket();
    const room = io.to(projectRoom(projectId));
    (origin ? room.except(origin) : room).emit(event, ...args);
  },

  /** Emits to an arbitrary room (e.g. `board:<id>`), except the socket that made the change. */
  toRoom<E extends keyof ServerToClientEvents>(roomName: string, event: E, ...args: Parameters<ServerToClientEvents[E]>): void {
    if (!io) return;
    const origin = originSocket();
    const room = io.to(roomName);
    (origin ? room.except(origin) : room).emit(event, ...args);
  },

  /** Call after the transaction commits. */
  taskChanged(e: { projectId: Types.ObjectId; taskId: Types.ObjectId; parentTaskId: Types.ObjectId | null; kind: TaskChangedEvent['kind']; actorId: Types.ObjectId }): void {
    if (!io) return;
    const payload: TaskChangedEvent = {
      projectId: e.projectId.toHexString(),
      taskId: e.taskId.toHexString(),
      parentTaskId: e.parentTaskId?.toHexString() ?? null,
      kind: e.kind,
      actorId: e.actorId.toHexString(),
    };
    const origin = originSocket();
    const room = io.to(projectRoom(payload.projectId));
    (origin ? room.except(origin) : room).emit('task:changed', payload);
  },
};
