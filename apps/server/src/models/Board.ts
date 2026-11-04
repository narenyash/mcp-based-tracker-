import { model, Schema, type Types } from 'mongoose';
import { WHITEBOARD_IMAGE_TYPES, WHITEBOARD_LIMITS, type WhiteboardImageType } from '@teamtrack/shared';
import { createSchema } from '../db/schema';

/** An image uploaded to a board. Bytes live in object storage; this is the allow-list of servable ids. */
export interface IBoardFile {
  fileId: string;
  mimeType: WhiteboardImageType;
  sizeBytes: number;
  createdBy: Types.ObjectId;
  createdAt: Date;
}

/**
 * Whiteboard metadata only. The drawing is the current BoardSnapshot (gzipped JSON in object storage).
 * `version` guards metadata edits; `sceneVersion` guards the drawing and is bumped by every saved
 * snapshot without touching `version`, so autosaves never invalidate a pending rename.
 */
export interface IBoard {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId;
  title: string;
  sceneVersion: number;
  currentSnapshotId: Types.ObjectId | null;
  elementCount: number;
  thumbnailKey: string | null;
  files: IBoardFile[];
  lastEditedBy: Types.ObjectId | null;
  lastEditedAt: Date;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const boardFile = new Schema<IBoardFile>(
  {
    fileId: { type: String, required: true, match: /^[a-f\d]{32}$/ },
    mimeType: { type: String, enum: WHITEBOARD_IMAGE_TYPES, required: true },
    sizeBytes: { type: Number, required: true, min: 1, max: WHITEBOARD_LIMITS.maxImageBytes },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    createdAt: { type: Date, required: true },
  },
  { _id: false, strict: 'throw' },
);

const schema = createSchema<IBoard>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, immutable: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    sceneVersion: { type: Number, default: 0, min: 0 },
    currentSnapshotId: { type: Schema.Types.ObjectId, default: null },
    elementCount: { type: Number, default: 0, min: 0, max: WHITEBOARD_LIMITS.maxElements },
    thumbnailKey: { type: String, default: null, maxlength: 512 },
    files: {
      type: [boardFile],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= WHITEBOARD_LIMITS.maxFilesPerBoard, message: `At most ${WHITEBOARD_LIMITS.maxFilesPerBoard} images` },
    },
    lastEditedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    lastEditedAt: { type: Date, required: true },
  },
  { collection: 'boards', softDelete: true, tenant: true },
);

// Board grid: newest activity first, per project or across visible projects.
schema.index({ workspaceId: 1, projectId: 1, lastEditedAt: -1, _id: -1 });
schema.index({ workspaceId: 1, lastEditedAt: -1, _id: -1 });

export const Board = model<IBoard>('Board', schema);
