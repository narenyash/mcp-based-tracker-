import {
  SEARCH_HIT_TYPES,
  type CalendarQuery,
  type CalendarResponseDto,
  type SearchHitDto,
  type SearchQuery,
  type SearchResponseDto,
} from '@teamtrack/shared';
import type { AuthContext } from '../../auth/context';
import { listCalendarSources, listSearchSources } from '../../services/discovery';
import { logger } from '../../observability/logger';
import { projectsService } from '../projects/projects.service';
import { keyToDate } from './time';

/** Each source gets this long; a slow or failing one is logged and left out, never failing the request. */
export const SOURCE_TIMEOUT_MS = 1_500;

class SourceTimeout extends Error {
  constructor() {
    super(`source timed out after ${SOURCE_TIMEOUT_MS} ms`);
  }
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SourceTimeout()), SOURCE_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Runs every source in parallel and keeps what came back in time. */
async function gather<S, T>(kind: 'search' | 'calendar', sources: [string, S][], call: (source: S) => Promise<T[]>): Promise<T[]> {
  const results = await Promise.allSettled(
    sources.map(([, source]) =>
      // A synchronous throw inside a source becomes a rejection like any other.
      withTimeout(Promise.resolve().then(() => call(source))),
    ),
  );
  const out: T[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out.push(...r.value);
    else logger.warn({ err: r.reason, source: sources[i]![0], kind }, 'discovery source skipped');
  });
  return out;
}

const TYPE_ORDER = new Map<string, number>(SEARCH_HIT_TYPES.map((t, i) => [t, i]));
const CALENDAR_TYPE_ORDER: Record<string, number> = { task: 0, ticket: 1, goal: 2 };

export const discoveryService = {
  /** Groups hits by type in a fixed order (tasks, tickets, goals, boards, projects, users), at most `limit` per type. */
  async search(ctx: AuthContext, q: SearchQuery): Promise<SearchResponseDto> {
    const hits = await gather('search', listSearchSources(), (source) => source(ctx, q.q, q.limit));
    const byType = new Map<string, SearchHitDto[]>();
    for (const hit of hits) {
      if (!TYPE_ORDER.has(hit.type)) continue;
      const list = byType.get(hit.type) ?? [];
      if (list.length < q.limit && !list.some((h) => h.id === hit.id)) list.push(hit);
      byType.set(hit.type, list);
    }
    return {
      groups: SEARCH_HIT_TYPES.flatMap((type) => {
        const items = byType.get(type);
        return items?.length ? [{ type, items }] : [];
      }),
    };
  },

  async calendar(ctx: AuthContext, q: CalendarQuery): Promise<CalendarResponseDto> {
    // 404 up front for a project the caller can't see, rather than an empty month.
    const projectId = q.projectId ? (await projectsService.access(ctx, q.projectId)).project._id : undefined;
    const range = { from: keyToDate(q.from), to: keyToDate(q.to), projectId, userId: q.mine ? ctx.userId : undefined };
    const items = await gather('calendar', listCalendarSources(), (source) => source(ctx, range));
    items.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (CALENDAR_TYPE_ORDER[a.type] ?? 9) - (CALENDAR_TYPE_ORDER[b.type] ?? 9) ||
        a.key.localeCompare(b.key, undefined, { numeric: true }),
    );
    return { items };
  },
};
