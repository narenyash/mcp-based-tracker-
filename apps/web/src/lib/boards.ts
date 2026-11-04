import { useEffect, useState } from 'react';
import { ERROR_CODES } from '@teamtrack/shared';
import type { BoardListParams } from '../api/boards';
import { problemOf } from './errors';

/*
 * Whiteboard helpers that don't need Excalidraw at runtime (so the boards grid stays light).
 * Excalidraw-dependent code lives in components/board/BoardCanvas.tsx, which is lazy-loaded.
 */

/** Query keys in one place. Everything sits under ['boards']. */
export const bk = {
  all: ['boards'] as const,
  lists: ['boards', 'list'] as const,
  list: (params: BoardListParams) => ['boards', 'list', params] as const,
  board: (id: string) => ['boards', 'one', id] as const,
  snapshots: (id: string) => ['boards', 'snapshots', id] as const,
};

/** The server's current sceneVersion when a save lost the race (409 STALE_VERSION), else null. */
export function staleSceneVersion(err: unknown): number | null {
  const p = problemOf(err);
  if (p?.status !== 409 || p.code !== ERROR_CODES.STALE_VERSION) return null;
  return typeof p.sceneVersion === 'number' ? p.sceneVersion : null;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "3 minutes ago", "yesterday", "just now". */
export function timeAgo(iso: string, now = Date.now()): string {
  const sec = Math.round((new Date(iso).getTime() - now) / 1000);
  for (const [unit, size] of UNITS) if (Math.abs(sec) >= size) return rtf.format(Math.round(sec / size), unit);
  return 'just now';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const CURSOR_COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#9333ea', '#0891b2', '#db2777', '#65a30d'];

/** A stable colour per user, for cursors and presence dots. */
export function colorFor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0;
  return CURSOR_COLORS[Math.abs(h) % CURSOR_COLORS.length]!;
}

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error('Could not read file'));
    r.readAsDataURL(blob);
  });
}

/** Follows the OS colour scheme, like the app's design tokens do. */
export function usePrefersDark(): boolean {
  const query = '(prefers-color-scheme: dark)';
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return dark;
}
