/*
 * Workspace-local calendar arithmetic. Days are "YYYY-MM-DD" keys in the workspace timezone; a key's
 * Date form is that day at 00:00 UTC (the convention due dates already use).
 */

const DAY_MS = 86_400_000;

export interface LocalNow {
  /** Today in the timezone. */
  dateKey: string;
  /** Minutes since local midnight. */
  minutes: number;
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  weekday: number;
}

function parts(timeZone: string, at: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
}

export const keyToDate = (key: string): Date => new Date(`${key}T00:00:00.000Z`);
export const dateToKey = (d: Date): string => d.toISOString().slice(0, 10);
export const addDays = (key: string, n: number): string => dateToKey(new Date(keyToDate(key).getTime() + n * DAY_MS));
const isoWeekday = (key: string): number => keyToDate(key).getUTCDay() || 7;

export function localNow(timeZone: string, now = new Date()): LocalNow {
  const p = parts(timeZone, now);
  const dateKey = `${p.year}-${p.month}-${p.day}`;
  return { dateKey, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: isoWeekday(dateKey) };
}

/** The UTC instant of local midnight starting `key` in `timeZone` (DST-safe: re-checks the offset once). */
export function startOfLocalDay(key: string, timeZone: string): Date {
  const wall = keyToDate(key).getTime();
  const offsetAt = (instant: number) => {
    const p = parts(timeZone, new Date(instant));
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - instant;
  };
  let guess = wall - offsetAt(wall);
  guess = wall - offsetAt(guess);
  return new Date(guess);
}

/** The most recent working day before `key` (Friday on a Monday), or plain yesterday without a work week. */
export function previousWorkingDay(key: string, workWeek: readonly number[]): string {
  const days = new Set(workWeek.map((d) => (d === 0 ? 7 : d)));
  for (let i = 1; i <= 7; i++) {
    const candidate = addDays(key, -i);
    if (!days.size || days.has(isoWeekday(candidate))) return candidate;
  }
  return addDays(key, -1);
}

/** "10:00" -> 600. */
export const hhmmToMinutes = (s: string): number => {
  const [h, m] = s.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export const isWorkingDay = (weekday: number, workWeek: readonly number[]): boolean =>
  !workWeek.length || workWeek.some((d) => (d === 0 ? 7 : d) === weekday);
