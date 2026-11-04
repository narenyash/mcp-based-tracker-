import type { CalendarParams } from '../api/planning';

/** Query keys for search, calendar and standups. */
export const planningKeys = {
  search: (q: string) => ['search', q] as const,
  calendar: (p: CalendarParams) => ['calendar', p.from, p.to, p.projectId ?? null, !!p.mine] as const,
  standups: ['standups'] as const,
  standupFeed: (date: string | undefined, projectId: string | undefined) => ['standups', 'feed', date ?? 'today', projectId ?? null] as const,
  suggestions: ['standups', 'suggestions'] as const,
};

/* -------------------------------------------------------------- local dates */

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" of a local Date (calendar math is done on local dates at noon to dodge DST edges). */
export const toKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromKey = (key: string) => new Date(`${key}T12:00:00`);
export const addDays = (key: string, n: number) => {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
};
export const todayKey = () => toKey(new Date());

/** "YYYY-MM" for the URL. */
export const isMonthKey = (s: string | null): s is string => !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export const monthOf = (key: string) => key.slice(0, 7);
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(y, m - 1 + n, 1, 12);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** The 6-week Monday-first grid covering a month (42 day keys). */
export function monthGrid(month: string): string[] {
  const first = fromKey(`${month}-01`);
  const lead = (first.getDay() + 6) % 7;
  const start = addDays(`${month}-01`, -lead);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function formatDay(key: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }): string {
  return fromKey(key).toLocaleDateString(undefined, opts);
}

/** Mon..Sun short labels in the browser's locale (2024-01-01 was a Monday). */
export const weekdayLabels = (style: 'short' | 'narrow' = 'short') =>
  Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i, 12).toLocaleDateString(undefined, { weekday: style }));

/* ----------------------------------------------------------- recent searches */

const RECENT_KEY = 'tt:recent-searches';
const RECENT_MAX = 5;

export function readRecentSearches(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function rememberSearch(q: string): string[] {
  const next = [q, ...readRecentSearches().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, RECENT_MAX);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: recents are a convenience only.
  }
  return next;
}

export const MOODS = [
  { value: 1, label: 'Rough' },
  { value: 2, label: 'Meh' },
  { value: 3, label: 'Okay' },
  { value: 4, label: 'Good' },
  { value: 5, label: 'Great' },
] as const;
