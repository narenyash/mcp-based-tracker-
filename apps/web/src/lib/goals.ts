import { useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type {
  GoalDetailDto,
  GoalDto,
  GoalListDto,
  GoalMeasure,
  GoalPeriod,
  GoalPeriodDto,
  GoalProgressInput,
  GoalScope,
  GoalStatus,
  KeyResultDto,
} from '@teamtrack/shared';
import { goalsApi, type GoalListParams } from '../api/goals';
import { toast, toastError } from '../stores/toast';
import { errorMessage, problemOf } from './errors';
import { addDays, formatDay, fromKey, todayKey } from './planning';

/** Query keys in one place so invalidation can't drift from the queries. Everything sits under ['goals']. */
export const gk = {
  all: ['goals'] as const,
  lists: ['goals', 'list'] as const,
  list: (p: GoalListParams) => ['goals', 'list', p] as const,
  summaries: ['goals', 'summary'] as const,
  summary: (period: GoalPeriod, date: string | undefined) => ['goals', 'summary', period, date ?? 'current'] as const,
  details: ['goals', 'one'] as const,
  goal: (id: string) => ['goals', 'one', id] as const,
  /** Candidate parents for the create/edit dialog. */
  parents: (period: GoalPeriod, date: string) => ['goals', 'parents', period, date] as const,
};

export const PERIOD_LABEL: Record<GoalPeriod, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
export const PERIOD_NOUN: Record<GoalPeriod, string> = { daily: 'day', weekly: 'week', monthly: 'month' };
export const STATUS_LABEL: Record<GoalStatus, string> = {
  active: 'Active',
  achieved: 'Achieved',
  missed: 'Missed',
  carried_over: 'Carried over',
  cancelled: 'Cancelled',
};
export const STATUS_CLASS: Record<GoalStatus, string> = {
  active: '',
  achieved: 'text-success',
  missed: 'text-danger',
  carried_over: 'text-muted',
  cancelled: 'text-subtle',
};
export const MEASURE_LABEL: Record<GoalMeasure, string> = { boolean: 'Done / not done', number: 'Number', percent: 'Percent', tasks: 'Linked tasks' };
export const SCOPE_LABEL: Record<GoalScope, string> = { personal: 'Personal', team: 'Team', project: 'Project' };

/** Goals roll up one level: daily -> weekly -> monthly. */
export const PARENT_PERIOD: Record<GoalPeriod, GoalPeriod | null> = { daily: 'weekly', weekly: 'monthly', monthly: null };

export const isGoalPeriod = (s: string | null): s is GoalPeriod => s === 'daily' || s === 'weekly' || s === 'monthly';
export const isDateKey = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/* ---------------------------------------------------------------- periods */

/** "Tue, Nov 3" / "Nov 2 – 8, 2026" / "November 2026". */
export function periodLabel(p: GoalPeriodDto): string {
  if (p.period === 'daily') return formatDay(p.start, { weekday: 'long', month: 'long', day: 'numeric' });
  if (p.period === 'monthly') return fromKey(p.start).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const s = fromKey(p.start);
  const e = fromKey(p.end);
  // Built from parts: a {day, year} format alone renders as "2026 (day: 8)" in some locales.
  const md = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const right = s.getMonth() === e.getMonth() ? String(e.getDate()) : md(e);
  return `${md(s)} – ${right}, ${e.getFullYear()}`;
}

/** Short label for a goal's own period (used on child goals and carry-over links). */
export function goalPeriodShort(g: Pick<GoalDto, 'period' | 'startDate' | 'endDate'>): string {
  if (g.period === 'daily') return formatDay(g.startDate);
  if (g.period === 'monthly') return fromKey(g.startDate).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  return `Week of ${formatDay(g.startDate, { month: 'short', day: 'numeric' })}`;
}

export const prevPeriodDate = (p: GoalPeriodDto) => addDays(p.start, -1);
export const nextPeriodDate = (p: GoalPeriodDto) => addDays(p.end, 1);
/** Uses the browser's calendar; the workspace timezone can differ by a day at the edges, which only affects the "this week" hint. */
export const containsToday = (p: { start: string; end: string }) => {
  const t = todayKey();
  return p.start <= t && t <= p.end;
};

export const hasEnded = (g: Pick<GoalDto, 'periodEnd'>) => Date.now() >= Date.parse(g.periodEnd);
export const isClosed = (g: Pick<GoalDto, 'status'>) => g.status === 'cancelled' || g.status === 'carried_over';
export const canCarryOver = (g: GoalDto) => g.canEdit && !g.carriedToId && (g.status === 'missed' || (g.status === 'active' && hasEnded(g)));

/* --------------------------------------------------------------- progress */

const ratio = (current: number, target: number) => (target > 0 ? Math.min(1, current / target) : 0);

/** Mirrors the server's progress rule, for optimistic updates only (the server's value always wins). */
export function computeProgress(g: Pick<GoalDto, 'keyResults' | 'measure' | 'target' | 'current' | 'tasks'>): number {
  if (g.keyResults.length) return Math.round((g.keyResults.reduce((a, kr) => a + ratio(kr.current, kr.target), 0) / g.keyResults.length) * 100);
  if (g.measure === 'tasks') return g.tasks.total ? Math.round((g.tasks.done / g.tasks.total) * 100) : 0;
  if (g.measure === 'boolean') return g.current >= 1 ? 100 : 0;
  return Math.round(ratio(g.current, g.target) * 100);
}

export function applyProgress(g: GoalDto, input: GoalProgressInput): GoalDto {
  const keyResults: KeyResultDto[] = g.keyResults.map((kr) => {
    const u = input.keyResults?.find((x) => x.id === kr.id);
    return u ? { ...kr, current: u.current } : kr;
  });
  const next = { ...g, keyResults, current: input.current ?? g.current };
  next.progressPct = computeProgress(next);
  if ((g.status === 'active' || g.status === 'achieved') && !hasEnded(g)) next.status = next.progressPct >= 100 ? 'achieved' : 'active';
  return next;
}

/** "3 / 10 km", "40%", "2 / 5 tasks", "Done". */
export function valueText(g: GoalDto): string {
  if (g.keyResults.length) return `${g.keyResults.length} key result${g.keyResults.length === 1 ? '' : 's'}`;
  switch (g.measure) {
    case 'boolean':
      return g.current >= 1 ? 'Done' : 'Not done';
    case 'percent':
      return `${g.current}%`;
    case 'tasks':
      return `${g.tasks.done} / ${g.tasks.total} task${g.tasks.total === 1 ? '' : 's'}`;
    default:
      return `${g.current} / ${g.target}${g.unit ? ` ${g.unit}` : ''}`;
  }
}

/* ------------------------------------------------------------------ cache */

/** Writes a fresh goal from the server into every cache that shows it. */
export function syncGoal(qc: QueryClient, goal: GoalDto): void {
  qc.setQueriesData<GoalListDto>({ queryKey: gk.lists }, (l) => l && { ...l, items: l.items.map((g) => (g.id === goal.id ? goal : g)) });
  qc.setQueriesData<GoalDetailDto>({ queryKey: gk.details }, (d) => {
    if (!d) return d;
    if (d.id === goal.id) return { ...d, ...goal };
    return d.children.some((c) => c.id === goal.id) ? { ...d, children: d.children.map((c) => (c.id === goal.id ? goal : c)) } : d;
  });
  void qc.invalidateQueries({ queryKey: gk.summaries });
}

/** Creates, deletes, carry-overs and link changes reshape lists: refetch rather than patch. */
export function refreshGoals(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: gk.all });
}

/** Shared error handler: a version conflict refetches and explains; anything else is a toast. */
export function goalErrorHandler(qc: QueryClient) {
  return (err: unknown) => {
    if (problemOf(err)?.code === 'STALE_VERSION') {
      toastError('Someone else just changed this goal. Showing the latest version.');
      refreshGoals(qc);
    } else if (problemOf(err)?.status === 409) {
      toastError(errorMessage(err));
      refreshGoals(qc);
    } else toastError(errorMessage(err));
  };
}

/** Latest known version of a goal (detail or any list), so writes never send a stale If-Match we already know about. */
export function latestGoal(qc: QueryClient, goal: GoalDto): GoalDto {
  const detail = qc.getQueryData<GoalDetailDto>(gk.goal(goal.id));
  let best: GoalDto = detail && detail.version >= goal.version ? detail : goal;
  for (const [, l] of qc.getQueriesData<GoalListDto>({ queryKey: gk.lists })) {
    const g = l?.items.find((x) => x.id === goal.id);
    if (g && g.version > best.version) best = g;
  }
  return best;
}

function patchEverywhere(qc: QueryClient, id: string, fn: (g: GoalDto) => GoalDto): void {
  qc.setQueriesData<GoalListDto>({ queryKey: gk.lists }, (l) => l && { ...l, items: l.items.map((g) => (g.id === id ? fn(g) : g)) });
  qc.setQueriesData<GoalDetailDto>({ queryKey: gk.details }, (d) => {
    if (!d) return d;
    if (d.id === id) return { ...d, ...fn(d) };
    return d.children.some((c) => c.id === id) ? { ...d, children: d.children.map((c) => (c.id === id ? fn(c) : c)) } : d;
  });
}

/** Optimistic progress update with rollback; a 409 refetches and toasts. */
export function useGoalProgress() {
  const qc = useQueryClient();
  return useMutation({
    // Progress writes run one at a time (optimistic updates still apply immediately), and each reads the
    // version the previous one returned, so quick successive edits don't 409 against ourselves.
    scope: { id: 'goal-progress' },
    mutationFn: ({ goal, input }: { goal: GoalDto; input: GoalProgressInput }) => goalsApi.progress(goal.id, input, latestGoal(qc, goal).version),
    onMutate: async ({ goal, input }) => {
      await qc.cancelQueries({ queryKey: gk.lists });
      await qc.cancelQueries({ queryKey: gk.details });
      const snapshot: [QueryKey, unknown][] = [
        ...qc.getQueriesData({ queryKey: gk.lists }),
        ...qc.getQueriesData({ queryKey: gk.details }),
      ];
      patchEverywhere(qc, goal.id, (g) => applyProgress(g, input));
      return { snapshot };
    },
    onError: (err, _vars, context) => {
      for (const [key, data] of context?.snapshot ?? []) qc.setQueryData(key, data);
      goalErrorHandler(qc)(err);
    },
    onSuccess: (goal, { goal: before }) => {
      syncGoal(qc, goal);
      if (goal.status === 'achieved' && before.status !== 'achieved') toast(`Achieved: ${goal.title}`);
    },
  });
}

export function useGoalDetail(id: string | null) {
  return useQuery({ queryKey: gk.goal(id ?? ''), queryFn: () => goalsApi.get(id!), enabled: !!id });
}
