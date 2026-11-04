import type { EntityType } from './enums';
import type { NotificationDto } from './types';

/** API requests carry the caller's socket id so the server can skip echoing their own change back. */
export const SOCKET_ID_HEADER = 'x-socket-id';
/** POSTs carrying this header run once per user and key; a retry gets the stored response (see the idempotency middleware). */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Events carry ids only, never task content: clients refetch through the REST API, which applies
 * the usual permission checks. A stale room membership therefore can't leak data.
 */
export interface TaskChangedEvent {
  projectId: string;
  taskId: string;
  parentTaskId: string | null;
  kind: 'created' | 'updated' | 'moved' | 'deleted';
  actorId: string;
}

export interface TicketChangedEvent {
  projectId: string;
  ticketId: string;
  kind: 'created' | 'updated' | 'moved' | 'deleted';
  actorId: string;
}

/** A comment was added, edited or deleted on something in a project (sent to the project room). */
export interface CommentChangedEvent {
  projectId: string;
  entityType: EntityType;
  entityId: string;
  commentId: string;
  kind: 'created' | 'updated' | 'deleted';
  actorId: string;
}

export interface GoalChangedEvent {
  goalId: string;
  kind: 'created' | 'updated' | 'deleted';
  actorId: string;
}

/* Whiteboards (board:<id> rooms). Elements are Excalidraw elements; the server treats them as opaque JSON. */
export interface BoardSceneUpdate {
  boardId: string;
  /** Changed elements only; receivers merge by element id + version. */
  elements: unknown[];
  /** Sender's socket id, so a tab ignores its own echo. */
  from: string;
}
export interface BoardPointer {
  boardId: string;
  userId: string;
  name: string;
  x: number;
  y: number;
}
export interface BoardPresence {
  boardId: string;
  users: { id: string; name: string }[];
}

export interface ServerToClientEvents {
  'notification:new': (n: NotificationDto) => void;
  'task:changed': (e: TaskChangedEvent) => void;
  'ticket:changed': (e: TicketChangedEvent) => void;
  'comment:changed': (e: CommentChangedEvent) => void;
  'goal:changed': (e: GoalChangedEvent) => void;
  'board:scene': (e: BoardSceneUpdate) => void;
  'board:pointer': (e: BoardPointer) => void;
  'board:presence': (e: BoardPresence) => void;
}

export interface ClientToServerEvents {
  'project:join': (projectId: string, ack: (res: { ok: boolean }) => void) => void;
  'project:leave': (projectId: string) => void;
  'board:join': (boardId: string, ack: (res: { ok: boolean }) => void) => void;
  'board:leave': (boardId: string) => void;
  'board:scene': (e: Omit<BoardSceneUpdate, 'from'>) => void;
  'board:pointer': (e: Pick<BoardPointer, 'boardId' | 'x' | 'y'>) => void;
}
