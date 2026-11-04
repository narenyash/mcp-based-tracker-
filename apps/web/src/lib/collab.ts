import { useEffect } from 'react';
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import {
  ATTACHMENT_MIME_TYPES,
  IMAGE_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  type ActivityChangeDto,
  type ActivityDto,
  type AttachmentMimeType,
  type EntityRef,
  type EntityType,
} from '@teamtrack/shared';
import { qk } from './tasks';
import { tk } from './tickets';

/** Query keys for comments, attachments and activity. Everything sits under ['collab']. */
export const ck = {
  all: ['collab'] as const,
  comments: (r: EntityRef) => ['collab', 'comments', r.entityType, r.entityId] as const,
  attachments: (r: EntityRef) => ['collab', 'attachments', r.entityType, r.entityId] as const,
  activity: (r: EntityRef) => ['collab', 'activity', r.entityType, r.entityId] as const,
  mentionable: (r: EntityRef, q: string) => ['collab', 'mentionable', r.entityType, r.entityId, q] as const,
};

export function refreshActivity(qc: QueryClient, r: EntityRef): void {
  void qc.invalidateQueries({ queryKey: ck.activity(r) });
}

/** The cache key of the entity itself, where this app has one, so collab panels can follow its edits. */
function entityKey(r: EntityRef): QueryKey | null {
  if (r.entityType === 'task') return qk.task(r.entityId);
  if (r.entityType === 'ticket') return tk.ticket(r.entityId);
  return null;
}

/**
 * Calls `onChange` whenever fresh data for the entity lands in the cache (a save in the drawer, or a refetch
 * after a socket event), so history stays current without its own socket event.
 */
export function useOnEntityChange(r: EntityRef, onChange: () => void): void {
  const qc = useQueryClient();
  const key = entityKey(r);
  const hash = key ? JSON.stringify(key) : null;
  useEffect(() => {
    if (!hash) return;
    let timer: number | undefined;
    const unsubscribe = qc.getQueryCache().subscribe((e) => {
      if (e.type !== 'updated' || e.action.type !== 'success' || JSON.stringify(e.query.queryKey) !== hash) return;
      // Coalesce bursts (setQueryData followed by an invalidation refetch).
      window.clearTimeout(timer);
      timer = window.setTimeout(onChange, 300);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [qc, hash, onChange]);
}

/* ------------------------------------------------------------------ time */

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}

export const fullDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/* ----------------------------------------------------------------- files */

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export const isImageMime = (m: AttachmentMimeType) => IMAGE_MIME_TYPES.includes(m);

/** Mirrors the server's accepted extensions; the server still decides from the bytes. */
const EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'log', 'md', 'csv'];

/** For the file picker's `accept`. */
export const ACCEPT_ATTR = [...ATTACHMENT_MIME_TYPES, ...EXTENSIONS.map((e) => `.${e}`)].join(',');

/** Client-side pre-check so obviously wrong files fail fast. Returns a reason, or null if it looks fine. */
export function rejectFile(file: File): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const typeOk = (ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.type) || EXTENSIONS.includes(ext);
  if (!typeOk) return `${file.name || 'This file'}: only images (PNG, JPEG, GIF, WebP), PDF, TXT and CSV files can be attached`;
  if (file.size === 0) return `${file.name || 'This file'} is empty`;
  if (file.size > MAX_ATTACHMENT_BYTES) return `${file.name || 'This file'} is ${formatBytes(file.size)}; files can be at most ${formatBytes(MAX_ATTACHMENT_BYTES)}`;
  return null;
}

/** Pasted screenshots arrive as "image.png"; give them a name worth keeping. */
export function namePastedFile(file: File): File {
  if (file.name && file.name !== 'image.png') return file;
  const ext = file.type.split('/')[1] ?? 'png';
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
  return new File([file], `Pasted image ${stamp}.${ext}`, { type: file.type });
}

/* -------------------------------------------------------------- activity */

/** A sentence fragment: plain text, or a value to emphasise. */
export type Part = string | { value: string };

const FIELD_LABEL: Record<string, string> = {
  stepsToReproduce: 'steps to reproduce',
  key_results: 'key results',
  carried_from: 'carried from',
  dueDate: 'due date',
};
const field = (f: string) => FIELD_LABEL[f] ?? f.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();

/** Enum values (ticket type/severity) are stored raw; everything else is already a display string. */
function value(f: string, v: string): string {
  if ((f === 'type' || f === 'severity') && /^[a-z_]+$/.test(v)) return v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ');
  return v;
}

const v = (f: string, s: string): Part => ({ value: value(f, s) });

function describeChange(c: ActivityChangeDto): Part[] {
  const name = field(c.field);
  if (c.field === 'assignee' || c.field === 'tester' || c.field === 'owner') {
    if (c.from === null && c.to !== null) return [`set ${name} to `, v(c.field, c.to)];
    if (c.from !== null && c.to === null) return [`removed `, v(c.field, c.from), ` as ${name}`];
  }
  if (c.from === null && c.to === null) return [`updated the ${name}`];
  if (c.from === null) return [`set ${name} to `, v(c.field, c.to!)];
  if (c.to === null) return [`cleared ${name} (was `, v(c.field, c.from), ')'];
  return [`changed ${name} from `, v(c.field, c.from), ' to ', v(c.field, c.to)];
}

function join(groups: Part[][]): Part[] {
  const out: Part[] = [];
  groups.forEach((g, i) => {
    if (i > 0) out.push(i === groups.length - 1 ? ' and ' : ', ');
    out.push(...g);
  });
  return out;
}

const change = (a: ActivityDto, f: string) => a.changes.find((c) => c.field === f);

/** "changed status from To do to Done", for the line after the actor's name. */
export function describeActivity(a: ActivityDto, noun: string): Part[] {
  const file = change(a, 'file');
  const checklist = change(a, 'checklist');
  const task = change(a, 'task');
  switch (a.action) {
    case 'created':
      return [`created this ${noun}`];
    case 'deleted':
      return [`deleted this ${noun}`];
    case 'commented':
      return ['commented'];
    case 'attached':
      return file?.to ? ['attached ', { value: file.to }] : ['attached a file'];
    case 'removed_attachment':
      return file?.from ? ['removed ', { value: file.from }] : ['removed a file'];
    case 'checklist_added':
      return checklist?.to ? ['added ', { value: checklist.to }, ' to the checklist'] : ['added a checklist item'];
    case 'checklist_checked':
      return checklist?.to ? ['checked off ', { value: checklist.to }] : ['checked off an item'];
    case 'checklist_unchecked':
      return checklist?.to ? ['unchecked ', { value: checklist.to }] : ['unchecked an item'];
    case 'checklist_edited':
      return checklist?.from && checklist.to ? ['renamed checklist item ', { value: checklist.from }, ' to ', { value: checklist.to }] : ['edited the checklist'];
    case 'checklist_removed':
      return checklist?.from ? ['removed ', { value: checklist.from }, ' from the checklist'] : ['removed a checklist item'];
    case 'linked':
      return task?.to ? ['linked ', { value: task.to }] : ['linked a task'];
    case 'unlinked':
      return task?.from ? ['unlinked ', { value: task.from }] : ['unlinked a task'];
    case 'converted':
      return task?.to ? ['converted this to task ', { value: task.to }] : ['converted this to a task'];
    case 'assigned': {
      const c = change(a, 'assignee');
      if (!c) return ['changed the assignee'];
      if (c.to === null) return c.from ? ['unassigned ', { value: c.from }] : ['unassigned this'];
      if (c.from === null) return ['assigned this to ', { value: c.to }];
      return ['reassigned this from ', { value: c.from }, ' to ', { value: c.to }];
    }
    case 'resolved': {
      const s = change(a, 'status');
      const r = change(a, 'resolution');
      return [r?.to ? 'resolved this as ' : 'resolved this', ...(r?.to ? [{ value: r.to }] : []), ...(s?.to ? [' (', { value: s.to }, ')'] : [])];
    }
    case 'reopened': {
      const s = change(a, 'status');
      return ['reopened this', ...(s?.to ? [' (', { value: s.to } as Part, ')'] : [])];
    }
    case 'moved': {
      const s = change(a, 'status');
      const rest = a.changes.filter((c) => c !== s);
      const groups = [...(s?.from && s.to ? [['moved this from ', { value: s.from }, ' to ', { value: s.to }] as Part[]] : []), ...rest.map(describeChange)];
      return groups.length ? join(groups) : ['moved this'];
    }
    case 'renamed': {
      const t = change(a, 'title');
      return t?.from && t.to ? ['renamed this from ', { value: t.from }, ' to ', { value: t.to }] : ['renamed this'];
    }
    case 'restored': {
      const ver = change(a, 'version');
      return ver?.to ? ['restored version ', { value: ver.to }] : ['restored an earlier version'];
    }
    case 'carried_over': {
      const p = change(a, 'period');
      return p?.to ? ['carried this over to ', { value: p.to }] : ['carried this over'];
    }
    default:
      if (a.changes.length) return join(a.changes.map(describeChange));
      return [a.action.replace(/_/g, ' ')];
  }
}

export const NOUN: Record<EntityType, string> = { task: 'task', ticket: 'ticket', goal: 'goal', board: 'board' };
