import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { SOCKET_ID_HEADER, type ClientToServerEvents, type ServerToClientEvents } from '@teamtrack/shared';
import { api, refreshSession } from '../api/client';
import { useAuth } from '../stores/auth';
import { toast } from '../stores/toast';
import { qk } from './tasks';
import { tk } from './tickets';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: AppSocket | null = null;
/** Project rooms this tab wants, ref-counted; re-joined after every reconnect. */
const rooms = new Map<string, number>();

// Tag API calls with this tab's socket so the server doesn't echo our own changes back.
api.interceptors.request.use((config) => {
  if (socket?.connected && socket.id) config.headers.set(SOCKET_ID_HEADER, socket.id);
  return config;
});

/** The shared socket (created on first use). Prefer useSocketEvent for listening. */
export function getSocket(): AppSocket {
  if (socket) return socket;
  const s: AppSocket = io({
    path: '/socket.io',
    autoConnect: false,
    transports: ['websocket'],
    // Read the token on every (re)connect, so a refreshed token is always used.
    auth: (cb) => cb({ token: useAuth.getState().accessToken }),
  });

  s.on('connect', () => {
    for (const id of rooms.keys()) s.emit('project:join', id, () => undefined);
  });
  // The server closes the socket when the access token expires; by then the client has refreshed it.
  s.on('disconnect', (reason) => {
    if (reason === 'io server disconnect' && useAuth.getState().accessToken) s.connect();
  });
  s.on('connect_error', (err) => {
    if (err.message !== 'unauthorized') return; // network errors: socket.io retries with backoff
    void refreshSession().then((ok) => ok && s.connect());
  });

  socket = s;
  return s;
}

// Signing out (or a failed refresh) drops the connection.
useAuth.subscribe((state, prev) => {
  if (prev.accessToken && !state.accessToken) {
    socket?.disconnect();
    socket = null;
  }
});

/** Connects while signed in and turns server events into cache refreshes. Mount once, in the app shell. */
export function useRealtime(): void {
  const qc = useQueryClient();
  const signedIn = useAuth((s) => s.status === 'authenticated');

  useEffect(() => {
    if (!signedIn) return;
    const s = getSocket();
    const onTask: ServerToClientEvents['task:changed'] = (e) => {
      void qc.invalidateQueries({ queryKey: qk.board(e.projectId) });
      void qc.invalidateQueries({ queryKey: qk.tasks });
      void qc.invalidateQueries({ queryKey: qk.task(e.taskId) });
      if (e.parentTaskId) void qc.invalidateQueries({ queryKey: qk.task(e.parentTaskId) });
    };
    const onTicket: ServerToClientEvents['ticket:changed'] = (e) => {
      void qc.invalidateQueries({ queryKey: tk.board(e.projectId) });
      void qc.invalidateQueries({ queryKey: tk.lists });
      void qc.invalidateQueries({ queryKey: tk.ticket(e.ticketId) });
    };
    const onNotification: ServerToClientEvents['notification:new'] = (n) => {
      void qc.invalidateQueries({ queryKey: qk.notifications });
      toast(n.title);
    };
    s.on('task:changed', onTask);
    s.on('ticket:changed', onTicket);
    s.on('notification:new', onNotification);
    if (!s.connected) s.connect();
    return () => {
      s.off('task:changed', onTask);
      s.off('ticket:changed', onTicket);
      s.off('notification:new', onNotification);
    };
  }, [signedIn, qc]);
}

/** Receives live board changes for a project while the component is mounted. */
export function useProjectRoom(projectId: string): void {
  useEffect(() => {
    if (!projectId) return;
    const s = getSocket();
    rooms.set(projectId, (rooms.get(projectId) ?? 0) + 1);
    if (s.connected) s.emit('project:join', projectId, () => undefined);
    return () => {
      const n = (rooms.get(projectId) ?? 1) - 1;
      if (n > 0) return void rooms.set(projectId, n);
      rooms.delete(projectId);
      if (s.connected) s.emit('project:leave', projectId);
    };
  }, [projectId]);
}

/** Subscribes to one server event while mounted. Keep `handler` stable (useCallback) to avoid resubscribing. */
export function useSocketEvent<E extends keyof ServerToClientEvents>(event: E, handler: ServerToClientEvents[E]): void {
  useEffect(() => {
    const s = getSocket();
    // socket.io's typed emitter needs the cast for generic event names.
    s.on(event, handler as never);
    return () => void s.off(event, handler as never);
  }, [event, handler]);
}
