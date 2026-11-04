import { z } from 'zod';
import type { PersonRef } from '../types';
import { objectIdSchema, paginationQuerySchema } from './common';

/*
 * Phase 7: whiteboards (Excalidraw). Named "whiteboard" in code because `BoardDto` is the task board.
 * Board metadata lives in Mongo; scenes are gzipped JSON snapshots in object storage.
 * Two concurrency tokens: `version` guards metadata (title, If-Match) and `sceneVersion` guards the
 * drawing (`baseVersion` on save), so an autosave never makes a rename fail and vice versa.
 */

export const WHITEBOARD_LIMITS = {
  maxElements: 20_000,
  /** Gzipped snapshot size. */
  maxSceneBytes: 5 * 1024 * 1024,
  maxImageBytes: 5 * 1024 * 1024,
  maxThumbnailBytes: 500 * 1024,
  maxFilesPerBoard: 500,
} as const;

export const WHITEBOARD_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type WhiteboardImageType = (typeof WHITEBOARD_IMAGE_TYPES)[number];

export const SNAPSHOT_REASONS = ['autosave', 'manual', 'restore'] as const;
export type SnapshotReason = (typeof SNAPSHOT_REASONS)[number];

/** Excalidraw file ids as issued by the server (also accepted as path params). */
export const whiteboardFileIdSchema = z.string().regex(/^[a-f\d]{32}$/, 'Invalid file id');

const title = z.string().trim().min(1, 'Title is required').max(120);

export const createWhiteboardSchema = z.object({ projectId: objectIdSchema, title });
export type CreateWhiteboardInput = z.infer<typeof createWhiteboardSchema>;

export const updateWhiteboardSchema = z.object({ title });
export type UpdateWhiteboardInput = z.infer<typeof updateWhiteboardSchema>;

export const listWhiteboardsQuerySchema = paginationQuerySchema.extend({ projectId: objectIdSchema.optional() });
export type ListWhiteboardsQuery = z.infer<typeof listWhiteboardsQuerySchema>;

/**
 * Elements are opaque Excalidraw JSON; only what merging relies on is checked (a string id and a numeric
 * version per element, ids unique). Everything else passes through untouched.
 */
export const sceneElementSchema = z
  .object({ id: z.string().min(1).max(64), version: z.number().int().nonnegative() })
  .passthrough();
export type SceneElement = z.infer<typeof sceneElementSchema>;

export const sceneElementsSchema = z
  .array(sceneElementSchema)
  .max(WHITEBOARD_LIMITS.maxElements, `A board can hold at most ${WHITEBOARD_LIMITS.maxElements} elements`)
  .superRefine((els, ctx) => {
    const seen = new Set<string>();
    for (const e of els) {
      if (seen.has(e.id)) return void ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate element id ${e.id}` });
      seen.add(e.id);
    }
  });

/** The persisted subset of Excalidraw's appState. */
export const sceneAppStateSchema = z
  .object({
    viewBackgroundColor: z.string().max(32),
    gridSize: z.number().int().min(1).max(100).nullable(),
  })
  .partial();
export type SceneAppState = z.infer<typeof sceneAppStateSchema>;

export const saveSceneSchema = z.object({
  elements: sceneElementsSchema,
  appState: sceneAppStateSchema.default({}),
  /** The sceneVersion the client's copy is based on; stale = 409 with the current sceneVersion. */
  baseVersion: z.number().int().min(0),
  reason: z.enum(['autosave', 'manual']).default('autosave'),
});
export type SaveSceneInput = z.infer<typeof saveSceneSchema>;

export const snapshotParamsSchema = z.object({ id: objectIdSchema, snapshotId: objectIdSchema });
export const whiteboardFileParamsSchema = z.object({ id: objectIdSchema, fileId: whiteboardFileIdSchema });

/* ------------------------------------------------------------------- DTOs */

export interface WhiteboardDto {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  sceneVersion: number;
  elementCount: number;
  /** Short-lived signed URL of the PNG preview, or null. */
  thumbnailUrl: string | null;
  lastEditedBy: PersonRef | null;
  lastEditedAt: string;
  createdBy: string;
  /** Whether the caller may draw on it (members of an active project). */
  canEdit: boolean;
  /** Whether the caller may delete it (project leads, admins, the creator). */
  canDelete: boolean;
  createdAt: string;
  version: number;
}

export interface WhiteboardSceneDto {
  elements: SceneElement[];
  appState: SceneAppState;
  /** Images referenced by the scene; load bytes from GET /boards/:id/files/:fileId. */
  files: Record<string, { mimeType: WhiteboardImageType }>;
}

export interface WhiteboardDetailDto extends WhiteboardDto {
  scene: WhiteboardSceneDto;
}

export interface WhiteboardSnapshotDto {
  id: string;
  sceneVersion: number;
  elementCount: number;
  sizeBytes: number;
  reason: SnapshotReason;
  createdBy: PersonRef | null;
  createdAt: string;
  /** The board's current state. */
  current: boolean;
}

export interface WhiteboardFileDto {
  fileId: string;
  mimeType: WhiteboardImageType;
  /** Short-lived signed URL. */
  url: string;
}
