import type { AttachmentMimeType } from '@teamtrack/shared';
import { MAX_FILE_NAME_LENGTH } from '@teamtrack/shared';

/*
 * Identifies uploads by their bytes. The client's file name and Content-Type are only hints: a renamed
 * executable or an SVG (script-capable) never gets stored, whatever it claims to be.
 */

export interface DetectedFile {
  mimeType: AttachmentMimeType;
  image: { width: number; height: number } | null;
}

/** Guard against decompression bombs and absurd headers. */
const MAX_IMAGE_SIDE = 30_000;

const EXTENSIONS: Record<AttachmentMimeType, string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt', 'log', 'md'],
  'text/csv': ['csv'],
};

const startsWith = (b: Buffer, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (b: Buffer, at: number, s: string) => b.length >= at + s.length && b.toString('latin1', at, at + s.length) === s;

/* ------------------------------------------------------------- dimensions */

function pngSize(b: Buffer) {
  // Signature (8) + IHDR length (4) + "IHDR" (4), then width and height as big-endian uint32.
  if (b.length < 24 || !ascii(b, 12, 'IHDR')) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gifSize(b: Buffer) {
  if (b.length < 10) return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function webpSize(b: Buffer) {
  if (b.length < 30) return null;
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // Lossy: keyframe start code 9d 01 2a at 23, then 14-bit width and height.
    if (!startsWith(b, [0x9d, 0x01, 0x2a], 23)) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    // Lossless: signature 0x2f at 20, then (width - 1) and (height - 1) packed in 14 bits each.
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // Extended: 24-bit (width - 1) at 24 and (height - 1) at 27.
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/** Walks JPEG segments to the first start-of-frame marker, which holds the dimensions. */
function jpegSize(b: Buffer) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan before any frame header
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  return null;
}

/* ----------------------------------------------------------------- types */

/** Text: valid UTF-8 without NULs or other binary control characters, and not markup. */
function isPlainText(b: Buffer): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) return false;
  // SVG and HTML are text too, but script-capable; refuse anything that opens like markup.
  const head = text.replace(/^\uFEFF/, '').trimStart().slice(0, 200).toLowerCase();
  return !/^<(\?xml|svg|!doctype|html|head|body|script|iframe)/.test(head) && !head.includes('<svg');
}

function detectImage(b: Buffer): DetectedFile | null {
  let mimeType: AttachmentMimeType;
  let size: { width: number; height: number } | null;
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) [mimeType, size] = ['image/png', pngSize(b)];
  else if (startsWith(b, [0xff, 0xd8, 0xff])) [mimeType, size] = ['image/jpeg', jpegSize(b)];
  else if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) [mimeType, size] = ['image/gif', gifSize(b)];
  else if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) [mimeType, size] = ['image/webp', webpSize(b)];
  else return null;
  const valid = !!size && size.width > 0 && size.height > 0 && size.width <= MAX_IMAGE_SIDE && size.height <= MAX_IMAGE_SIDE;
  if (!valid) throw new UnreadableImageError();
  return { mimeType, image: size };
}

export class UnreadableImageError extends Error {}

/**
 * Returns the file's real type (and image size), or null if it isn't an allowed type.
 * Throws UnreadableImageError for an image whose header is truncated or nonsensical.
 */
export function detectFile(bytes: Buffer, fileName: string): DetectedFile | null {
  const ext = extensionOf(fileName);
  if (ext === 'svg' || ext === 'svgz') return null;
  const image = detectImage(bytes);
  if (image) return image;
  if (ascii(bytes, 0, '%PDF-')) return { mimeType: 'application/pdf', image: null };
  if (isPlainText(bytes)) return { mimeType: ext === 'csv' ? 'text/csv' : 'text/plain', image: null };
  return null;
}

/* ------------------------------------------------------------- file names */

const extensionOf = (name: string) => /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1]?.toLowerCase() ?? '';

/**
 * Display name: no path, no control or reserved characters, at most 200 characters, and an extension that
 * matches the real type (so "photo.txt" holding a PNG downloads as "photo.txt.png").
 */
export function displayFileName(raw: string, mimeType: AttachmentMimeType): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let name = base.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  const allowed = EXTENSIONS[mimeType];
  const suffix = allowed.includes(extensionOf(name)) ? '' : `.${allowed[0]}`;
  name = (name || 'file').slice(0, MAX_FILE_NAME_LENGTH - suffix.length);
  return name + suffix;
}

/** Storage-key-safe version of a display name (ASCII letters, digits, dot, dash, underscore). */
export function keySafeName(display: string): string {
  const safe = display
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+/, '');
  const ext = extensionOf(safe);
  const stem = (ext ? safe.slice(0, -(ext.length + 1)) : safe).slice(0, 80) || 'file';
  return ext ? `${stem}.${ext}` : stem;
}
