import type {
  CalendarResponseDto,
  Page,
  SearchResponseDto,
  StandupDto,
  StandupFeedDto,
  StandupSuggestionsDto,
  UpsertStandupInput,
} from '@teamtrack/shared';
import { api } from './client';

export const searchApi = {
  search: (q: string, signal?: AbortSignal) =>
    api.get<SearchResponseDto>('/search', { params: { q, limit: 5 }, ...(signal ? { signal } : {}) }).then((r) => r.data),
};

export interface CalendarParams {
  from: string;
  to: string;
  projectId?: string | undefined;
  mine?: boolean | undefined;
}

export const calendarApi = {
  range: ({ from, to, projectId, mine }: CalendarParams) =>
    api
      .get<CalendarResponseDto>('/calendar', { params: { from, to, ...(projectId ? { projectId } : {}), ...(mine ? { mine: 'true' } : {}) } })
      .then((r) => r.data.items),
};

export const standupsApi = {
  feed: (params: { date?: string | undefined; projectId?: string | undefined }) =>
    api.get<StandupFeedDto>('/standups', { params }).then((r) => r.data),
  /** Pass the current version when updating; omit it for the day's first save. */
  saveMine: (input: Partial<UpsertStandupInput>, version?: number) =>
    api
      .put<StandupDto>('/standups/me', input, version === undefined ? {} : { headers: { 'If-Match': `"${version}"` } })
      .then((r) => r.data),
  history: (cursor?: string) => api.get<Page<StandupDto>>('/standups/me/history', { params: { cursor } }).then((r) => r.data),
  suggestions: () => api.get<StandupSuggestionsDto>('/standups/me/suggestions').then((r) => r.data),
};
