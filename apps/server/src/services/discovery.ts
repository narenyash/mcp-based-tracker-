import type { Types } from 'mongoose';
import type { CalendarItemDto, SearchHitDto } from '@teamtrack/shared';
import type { AuthContext } from '../auth/context';

/*
 * Cross-module discovery: global search (Ctrl+K) and the calendar. Each module registers a source for
 * its own data (in its register.ts); the planning module serves the endpoints. Sources must apply
 * their own visibility rules: only return what the caller may open.
 */

export type SearchSource = (ctx: AuthContext, q: string, limit: number) => Promise<SearchHitDto[]>;

export interface CalendarRange {
  /** Inclusive calendar days as UTC midnights (due dates are stored that way). */
  from: Date;
  to: Date;
  projectId?: Types.ObjectId | undefined;
  /** Only items assigned to / owned by this user. */
  userId?: Types.ObjectId | undefined;
}
export type CalendarSource = (ctx: AuthContext, range: CalendarRange) => Promise<CalendarItemDto[]>;

const searchSources = new Map<string, SearchSource>();
const calendarSources = new Map<string, CalendarSource>();

export function registerSearchSource(name: string, source: SearchSource): void {
  searchSources.set(name, source);
}
export function registerCalendarSource(name: string, source: CalendarSource): void {
  calendarSources.set(name, source);
}
export const listSearchSources = () => [...searchSources.entries()];
export const listCalendarSources = () => [...calendarSources.entries()];
