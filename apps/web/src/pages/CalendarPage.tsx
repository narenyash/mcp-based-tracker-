import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { CalendarItemDto } from '@teamtrack/shared';
import { projectsApi } from '../api/endpoints';
import { calendarApi } from '../api/planning';
import { errorMessage } from '../lib/errors';
import { formatDay, fromKey, isMonthKey, monthGrid, monthOf, planningKeys, shiftMonth, todayKey, weekdayLabels } from '../lib/planning';
import { Button, cx, ErrorNote, PageHeader, Select, Spinner } from '../components/ui';
import { CalendarChip, DaySheet } from '../components/planning/CalendarBits';

const PER_DAY = 3;

/** Phase 8: month grid of task/ticket due dates and goals (an agenda list on narrow screens). */
export function CalendarPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const today = todayKey();
  const monthParam = params.get('month');
  const month = isMonthKey(monthParam) ? monthParam : monthOf(today);
  const mine = params.get('mine') === 'true';
  const projectId = params.get('projectId') ?? undefined;
  const [openDay, setOpenDay] = useState<string | null>(null);

  const setParam = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: key !== 'month' },
    );

  const days = useMemo(() => monthGrid(month), [month]);
  const range = { from: days[0]!, to: days.at(-1)!, projectId, mine };
  const calendar = useQuery({
    queryKey: planningKeys.calendar(range),
    queryFn: () => calendarApi.range(range),
    placeholderData: keepPreviousData,
  });
  const projects = useQuery({ queryKey: ['projects', 'active'], queryFn: () => projectsApi.list({ status: 'active' }), staleTime: 60_000 });

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarItemDto[]>();
    for (const item of calendar.data ?? []) map.set(item.date, [...(map.get(item.date) ?? []), item]);
    return map;
  }, [calendar.data]);

  const open = (item: CalendarItemDto) => {
    setOpenDay(null);
    navigate(item.path);
  };
  const title = fromKey(`${month}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const monthDays = days.filter((d) => monthOf(d) === month);
  const agenda = monthDays.filter((d) => byDay.has(d));

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Due dates across your projects"
        actions={
          <>
            <label className="flex items-center gap-1.5 text-sm text-muted">
              <input type="checkbox" checked={mine} onChange={(e) => setParam('mine', e.target.checked ? 'true' : null)} className="accent-current" />
              Only mine
            </label>
            <Select
              aria-label="Project"
              value={projectId ?? ''}
              onChange={(e) => setParam('projectId', e.target.value || null)}
              className="h-8 w-44 text-xs"
            >
              <option value="">All projects</option>
              {projects.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </>
        }
      />

      <div className="mb-4 flex items-center gap-2">
        <h2 className="mr-auto text-base font-medium">{title}</h2>
        {calendar.isFetching && <Spinner className="size-3.5" />}
        <Button size="sm" variant="ghost" aria-label="Previous month" onClick={() => setParam('month', shiftMonth(month, -1))}>
          <ChevronLeft className="size-4" />
        </Button>
        <Button size="sm" onClick={() => setParam('month', null)} disabled={month === monthOf(today)}>
          Today
        </Button>
        <Button size="sm" variant="ghost" aria-label="Next month" onClick={() => setParam('month', shiftMonth(month, 1))}>
          <ChevronRight className="size-4" />
        </Button>
      </div>

      {calendar.isError && (
        <div className="mb-4">
          <ErrorNote>{errorMessage(calendar.error)}</ErrorNote>
        </div>
      )}

      {/* Month grid (md and up). */}
      <div className="hidden overflow-hidden rounded-lg border border-border md:block">
        <div className="grid grid-cols-7 border-b border-border bg-surface">
          {weekdayLabels().map((d) => (
            <div key={d} className="px-2 py-1.5 text-2xs font-medium text-subtle">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((day, i) => {
            const items = byDay.get(day) ?? [];
            const outside = monthOf(day) !== month;
            return (
              <div
                key={day}
                className={cx('min-h-28 min-w-0 border-border p-1', i % 7 !== 6 && 'border-r', i < 35 && 'border-b', outside && 'bg-surface')}
              >
                <div className="mb-0.5 flex px-1">
                  <span
                    className={cx(
                      'inline-flex size-5 items-center justify-center rounded-full text-2xs tabular-nums',
                      day === today ? 'bg-accent font-medium text-accent-fg' : outside ? 'text-subtle' : 'text-muted',
                    )}
                    aria-current={day === today ? 'date' : undefined}
                  >
                    {fromKey(day).getDate()}
                  </span>
                </div>
                {items.slice(0, PER_DAY).map((item) => (
                  <CalendarChip key={`${item.type}:${item.id}`} item={item} onOpen={open} />
                ))}
                {items.length > PER_DAY && (
                  <button onClick={() => setOpenDay(day)} className="mt-0.5 rounded px-1 text-2xs text-muted hover:bg-hover hover:text-fg">
                    +{items.length - PER_DAY} more
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Agenda (narrow screens). */}
      <div className="md:hidden">
        {calendar.isPending ? (
          <Spinner />
        ) : agenda.length ? (
          <ul className="space-y-4">
            {agenda.map((day) => (
              <li key={day}>
                <p className={cx('mb-1 text-xs font-medium', day === today ? 'text-fg' : 'text-muted')}>
                  {formatDay(day)}
                  {day === today && ' · Today'}
                </p>
                <div className="rounded-lg border border-border p-1">
                  {byDay.get(day)!.map((item) => (
                    <CalendarChip key={`${item.type}:${item.id}`} item={item} onOpen={open} roomy />
                  ))}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Nothing due this month</p>
        )}
      </div>

      <DaySheet day={openDay} items={openDay ? (byDay.get(openDay) ?? []) : []} onClose={() => setOpenDay(null)} onOpen={open} />
    </>
  );
}
