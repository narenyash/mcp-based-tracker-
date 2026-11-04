import { randomInt } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { SceneAppState, SceneElement, WhiteboardImageType } from '@teamtrack/shared';
import { ERROR_CODES } from '@teamtrack/shared';
import { AppError, ValidationError } from '../../errors/AppError';

/*
 * Scene encoding and the few places the server looks inside Excalidraw elements. Elements are otherwise
 * opaque: the server reads only id, version, isDeleted, type and fileId.
 */

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Inflated size cap for uploaded scenes (a zip bomb stops here, not in JSON.parse, which blocks the event
 * loop). 20k elements at the usual 0.3-1 KB of JSON each fit with room to spare.
 */
export const MAX_INFLATED_BYTES = 32 * 1024 * 1024;
/** Stored snapshots were written by the server under the older, looser cap; keep reading them. */
const MAX_STORED_INFLATED_BYTES = 128 * 1024 * 1024;

/** What a snapshot object holds (gzipped JSON). `storageKey` never leaves the server. */
export interface StoredScene {
  elements: SceneElement[];
  appState: SceneAppState;
  files: Record<string, { mimeType: WhiteboardImageType; storageKey: string }>;
}

export const EMPTY_SCENE: StoredScene = { elements: [], appState: {}, files: {} };

export function encodeScene(scene: StoredScene): Promise<Buffer> {
  return gzipAsync(Buffer.from(JSON.stringify(scene)));
}

export async function decodeScene(body: Buffer): Promise<StoredScene> {
  const raw = await gunzipAsync(body, { maxOutputLength: MAX_STORED_INFLATED_BYTES });
  return JSON.parse(raw.toString('utf8')) as StoredScene;
}

/** A gzipped JSON request body (large scenes exceed the JSON parser's 1 MB limit uncompressed). */
export async function decodeGzipJson(body: Buffer): Promise<unknown> {
  try {
    const raw = await gunzipAsync(body, { maxOutputLength: MAX_INFLATED_BYTES });
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new AppError(413, ERROR_CODES.VALIDATION_FAILED, `This board is too large to save (over ${MAX_INFLATED_BYTES / 1024 / 1024} MB uncompressed). Remove some drawings.`);
    }
    throw new ValidationError([{ path: '(root)', message: 'Body must be gzipped JSON' }]);
  }
}

/** Detects the image type from its first bytes; the declared Content-Type is never trusted. */
export function sniffImage(buf: Buffer): WhiteboardImageType | null {
  const starts = (sig: number[], at = 0) => buf.length >= at + sig.length && sig.every((b, i) => buf[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38]) && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

const isLive = (e: SceneElement) => e.isDeleted !== true;

export function liveCount(elements: SceneElement[]): number {
  return elements.reduce((n, e) => n + (isLive(e) ? 1 : 0), 0);
}

/** File ids used by live image elements. */
export function referencedFileIds(elements: SceneElement[]): Set<string> {
  const ids = new Set<string>();
  for (const e of elements) if (isLive(e) && e.type === 'image' && typeof e.fileId === 'string') ids.add(e.fileId);
  return ids;
}

/**
 * Turns a snapshot back into the current scene in a way that survives merging. Clients reconcile by
 * element version, so restored elements get a version above anything currently on the board, and
 * elements added since the snapshot become deleted tombstones (also with a higher version).
 * Returns the full new element list.
 */
export function restoreElements(current: SceneElement[], snapshot: SceneElement[]): SceneElement[] {
  const now = Date.now();
  const bump = (e: SceneElement, floor: number): SceneElement => ({ ...e, version: Math.max(e.version, floor) + 1, versionNonce: randomInt(2 ** 31), updated: now });
  const byId = new Map(current.map((e) => [e.id, e]));
  const kept = new Set(snapshot.map((e) => e.id));
  const restored = snapshot.map((e) => bump(e, byId.get(e.id)?.version ?? 0));
  const removed = current.filter((e) => !kept.has(e.id) && isLive(e)).map((e) => bump({ ...e, isDeleted: true }, e.version));
  return [...restored, ...removed];
}
