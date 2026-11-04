import type { Types } from 'mongoose';
import type { StatusCategory } from '@teamtrack/shared';
import { logger } from '../observability/logger';

/**
 * In-process domain events, emitted after a transaction commits. They decouple modules (e.g. goals
 * recompute progress when a linked task changes) without the emitter knowing who listens.
 * Listeners run asynchronously and must be idempotent; a failing listener is logged, never thrown
 * back into the request. Work that must not be lost belongs in the outbox instead.
 */
export interface DomainEvents {
  'task.changed': {
    workspaceId: Types.ObjectId;
    projectId: Types.ObjectId;
    taskId: Types.ObjectId;
    kind: 'created' | 'updated' | 'moved' | 'deleted';
    statusCategory: StatusCategory;
    actorId: Types.ObjectId;
  };
  'ticket.changed': {
    workspaceId: Types.ObjectId;
    projectId: Types.ObjectId;
    ticketId: Types.ObjectId;
    kind: 'created' | 'updated' | 'moved' | 'deleted';
    actorId: Types.ObjectId;
  };
}

type Listener<E extends keyof DomainEvents> = (payload: DomainEvents[E]) => void | Promise<void>;

const listeners = new Map<keyof DomainEvents, Listener<never>[]>();
const pending = new Set<Promise<void>>();

export const bus = {
  on<E extends keyof DomainEvents>(event: E, listener: Listener<E>): void {
    listeners.set(event, [...(listeners.get(event) ?? []), listener as Listener<never>]);
  },

  emit<E extends keyof DomainEvents>(event: E, payload: DomainEvents[E]): void {
    for (const listener of (listeners.get(event) ?? []) as Listener<E>[]) {
      const run = (async () => {
        try {
          await listener(payload);
        } catch (err) {
          logger.error({ err, event }, 'domain event listener failed');
        }
      })();
      pending.add(run);
      void run.finally(() => pending.delete(run));
    }
  },

  /** Waits for in-flight listeners (tests, graceful shutdown). */
  async drain(): Promise<void> {
    while (pending.size) await Promise.all([...pending]);
  },
};
