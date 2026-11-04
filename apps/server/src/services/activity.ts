import type { ClientSession, Types } from 'mongoose';
import type { EntityType } from '@teamtrack/shared';

/** One field change in an activity entry. Values are short display strings (names, not ids). */
export interface ActivityChange {
  field: string;
  from: string | null;
  to: string | null;
}

export interface ActivityEntry {
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId | null;
  entityType: EntityType;
  entityId: Types.ObjectId;
  /** Readable key at the time (WEB-12, TCK-3, goal title...). */
  entityKey: string;
  actorId: Types.ObjectId;
  /** Verb in snake_case: created, updated, moved, assigned, commented, attached, deleted, converted... */
  action: string;
  changes?: ActivityChange[];
}

type Sink = (session: ClientSession | null, entries: ActivityEntry[]) => Promise<void>;
let sink: Sink = async () => undefined;

/** The collab module installs the real writer (append-only activity collection) at startup. */
export function setActivitySink(next: Sink): void {
  sink = next;
}

/**
 * Appends to the activity log. Pass the business transaction's session so the entry commits (or rolls
 * back) with the change it describes.
 */
export function recordActivity(session: ClientSession | null, ...entries: ActivityEntry[]): Promise<void> {
  return entries.length ? sink(session, entries) : Promise.resolve();
}
