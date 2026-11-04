import { model, Schema, type Types } from 'mongoose';
import { SNAPSHOT_REASONS, WHITEBOARD_LIMITS, type SnapshotReason } from '@teamtrack/shared';
import { createSchema } from '../db/schema';

/**
 * One saved state of a board. Immutable; the content is gzipped JSON at `storageKey`
 * (`{ elements, appState, files }`), never inside the document. Pruned by retention, not soft-deleted.
 */
export interface IBoardSnapshot {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  boardId: Types.ObjectId;
  sceneVersion: number;
  storageKey: string;
  sizeBytes: number;
  elementCount: number;
  reason: SnapshotReason;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const schema = createSchema<IBoardSnapshot>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, immutable: true },
    boardId: { type: Schema.Types.ObjectId, ref: 'Board', required: true, immutable: true },
    sceneVersion: { type: Number, required: true, min: 1, immutable: true },
    storageKey: { type: String, required: true, maxlength: 512, immutable: true },
    sizeBytes: { type: Number, required: true, min: 1, max: WHITEBOARD_LIMITS.maxSceneBytes, immutable: true },
    elementCount: { type: Number, required: true, min: 0, max: WHITEBOARD_LIMITS.maxElements, immutable: true },
    reason: { type: String, enum: SNAPSHOT_REASONS, required: true, immutable: true },
  },
  { collection: 'boardSnapshots', tenant: true },
);

// One snapshot per scene version; also serves history (newest first) and retention scans.
schema.index({ boardId: 1, sceneVersion: -1 }, { unique: true });

export const BoardSnapshot = model<IBoardSnapshot>('BoardSnapshot', schema);
