import type { GoalPeriod, GoalPeriodDto } from '@teamtrack/shared';

/*
 * Calendar math for goal periods, with no date library. Days are "YYYY-MM-DD" strings on the
 * workspace calendar; arithmetic on them is done at UTC midnight, where every day is 24 h long.
 * Only the conversion of a calendar day to an exact instant needs the timezone (zonedMidnight).
 */

const DAY_MS = 24 * 3600_000;

/** The period one level up that a goal rolls up into (daily -> weekly -> monthly). */
export const PARENT_PERIOD: Record<GoalPeriod, GoalPeriod | null> = { daily: 'weekly', weekly: 'monthly', monthly: null };

export interface PeriodRange extends GoalPeriodDto {
  /** Exact UTC bounds of the period in the workspace timezone, half-open: [periodStart, periodEnd). */
  periodStart: Date;
  periodEnd: Date;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const parseDay = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const formatDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (day: string, n: number): string => formatDay(parseDay(day) + n * DAY_MS);

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of an instant in a timezone. */
function wallClock(timeZone: string, instant: number): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}

/** How far the timezone is ahead of UTC at an instant, in ms (e.g. +5:30 for Asia/Kolkata). */
function offsetAt(timeZone: string, instant: number): number {
  const w = wallClock(timeZone, instant);
  const whole = instant - (((instant % 1000) + 1000) % 1000);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - whole;
}

/** The calendar day of an instant in a timezone. */
export function localDay(timeZone: string, now: Date): string {
  const w = wallClock(timeZone, now.getTime());
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

/**
 * The instant a calendar day starts in a timezone. The second pass corrects for an offset change
 * (DST) between UTC midnight and local midnight.
 */
export function zonedMidnight(timeZone: string, day: string): Date {
  const wall = parseDay(day);
  const guess = wall - offsetAt(timeZone, wall);
  return new Date(wall - offsetAt(timeZone, guess));
}

/** ISO 8601 week of a day: weeks start on Monday and belong to the year of their Thursday. */
export function isoWeek(day: string): { year: number; week: number; monday: string } {
  const ms = parseDay(day);
  const monday = ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS;
  const thursday = monday + 3 * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return { year, week, monday: formatDay(monday) };
}

/** Monday of ISO week 1, the week containing January 4th. */
function isoWeekOneMonday(year: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  return jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
}

/** First and last day (inclusive) of the period containing `day`, and its key. */
export function calendarPeriod(period: GoalPeriod, day: string): GoalPeriodDto {
  switch (period) {
    case 'daily':
      return { period, key: day, start: day, end: day };
    case 'weekly': {
      const w = isoWeek(day);
      return { period, key: `${w.year}-W${pad(w.week)}`, start: w.monday, end: addDays(w.monday, 6) };
    }
    case 'monthly': {
      const y = Number(day.slice(0, 4));
      const m = Number(day.slice(5, 7));
      return { period, key: day.slice(0, 7), start: `${day.slice(0, 7)}-01`, end: formatDay(Date.UTC(y, m, 0)) };
    }
  }
}

/** First and last day of a period from its key alone ("2026-11-01", "2026-W44", "2026-11"). */
export function keyRange(period: GoalPeriod, key: string): GoalPeriodDto {
  switch (period) {
    case 'daily':
      return calendarPeriod(period, key);
    case 'weekly': {
      const monday = isoWeekOneMonday(Number(key.slice(0, 4))) + (Number(key.slice(6)) - 1) * 7 * DAY_MS;
      return calendarPeriod(period, formatDay(monday));
    }
    case 'monthly':
      return calendarPeriod(period, `${key}-01`);
  }
}

/** The period containing `day`, with its exact UTC bounds in the workspace timezone. */
export function periodContaining(period: GoalPeriod, day: string, timeZone: string): PeriodRange {
  const cal = calendarPeriod(period, day);
  return { ...cal, periodStart: zonedMidnight(timeZone, cal.start), periodEnd: zonedMidnight(timeZone, addDays(cal.end, 1)) };
}

/** The period right after one (for carry-over). */
export function nextPeriod(period: GoalPeriod, key: string, timeZone: string): PeriodRange {
  return periodContaining(period, addDays(keyRange(period, key).end, 1), timeZone);
}

/**
 * Whether a goal in `parent` can collect one in `child`: exactly one level up, and the periods share
 * at least one day. A week that straddles two months may roll up into either month.
 */
export function canRollUp(child: GoalPeriodDto, parent: GoalPeriodDto): boolean {
  return PARENT_PERIOD[child.period] === parent.period && parent.start <= child.end && child.start <= parent.end;
}
