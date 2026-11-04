import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { GOAL_PERIODS, hasRoleAtLeast, type GoalChangedEvent, type GoalDto, type GoalPeriod, type GoalScope, type GoalSummaryDto } from '@teamtrack/shared';
import { goalsApi } from '../api/goals';
import { errorMessage } from '../lib/errors';
import {
  containsToday,
  gk,
  isDateKey,
  isGoalPeriod,
  nextPeriodDate,
  PERIOD_LABEL,
  PERIOD_NOUN,
  periodLabel,
  prevPeriodDate,
} from '../lib/goals';
import { useSocketEvent } from '../lib/realtime';
import { useAuth } from '../stores/auth';
import { Avatar, Button, cx, EmptyState, ErrorNote, PageHeader, Select, Spinner, Tabs } from '../components/ui';
import { GoalCard } from '../components/goals/GoalCard';
import { GoalDialog } from '../components/goals/GoalDialog';
import { GoalSheet } from '../components/goals/GoalSheet';
import { ProgressBar } from '../components/goals/GoalBits';

const isObjectId = (s: string | null): s is string => !!s && /^[a-f\d]{24}$/i.test(s);
const STATUS_ORDER: Record<GoalDto['status'], number> = { active: 0, achieved: 1, missed: 2, carried_over: 3, cancelled: 4 };
const SCOPE_SECTIONS: { scope: GoalScope; title: string }[] = [
  { scope: 'team', title: 'Team goals' },
  { scope: 'project', title: 'Project goals' },
  { scope: 'personal', title: 'Personal goals' },
];

/** Phase 6: Daily / Weekly / Monthly goals, Mine / Team (and per person for managers), period navigator. All view state lives in the URL. */
export function GoalsPage() {
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const isManager = hasRoleAtLeast(me?.role ?? 'guest', 'manager');
  const [params, setParams] = useSearchParams();

  const periodParam = params.get('period');
  const period: GoalPeriod = isGoalPeriod(periodParam) ? periodParam : 'weekly';
  const dateParam = params.get('date');
  const date = isDateKey(dateParam) ? dateParam : undefined;
  const ownerParam = params.get('owner');
  const owner = ownerParam === 'team' || isObjectId(ownerParam) ? ownerParam : 'me';
  const openGoalId = params.get('goal');

  const [dialog, setDialog] = useState<{ goal?: GoalDto } | null>(null);

  const update = (fn: (p: URLSearchParams) => void, replace = false) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        fn(next);
        return next;
      },
      { replace },
    );
  const setPeriod = (p: GoalPeriod) =>
    update((n) => {
      if (p === 'weekly') n.delete('period');
      else n.set('period', p);
    });
  const goToDate = (d: string | null) =>
    update((n) => {
      if (!d || containsToday({ start: d, end: d })) n.delete('date');
      else n.set('date', d);
    });
  const setOwner = (o: string) =>
    update((n) => {
      if (o === 'me') n.delete('owner');
      else n.set('owner', o);
    });
  const openGoal = (id: string | null) =>
    update((n) => {
      if (id) n.set('goal', id);
      else n.delete('goal');
    });

  const list = useQuery({
    queryKey: gk.list({ period, date, owner }),
    queryFn: () => goalsApi.list({ period, date, owner }),
    placeholderData: keepPreviousData,
  });
  const summary = useQuery({
    queryKey: gk.summary(period, date),
    queryFn: () => goalsApi.summary({ period, date }),
    placeholderData: keepPreviousData,
  });

  // Other people's changes (and the rollover job) arrive over the socket; our own writes already updated the cache.
  const onGoalChanged = useCallback(
    (e: GoalChangedEvent) => {
      if (e.actorId !== me?.id) void qc.invalidateQueries({ queryKey: gk.all });
    },
    [qc, me?.id],
  );
  useSocketEvent('goal:changed', onGoalChanged);

  const p = list.data?.period ?? summary.data?.period;
  const isCurrent = !date || (!!p && containsToday(p));
  const items = [...(list.data?.items ?? [])].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const showOwner = owner !== 'me';
  const people = summary.data?.people ?? [];
  const selectedPerson = isObjectId(owner) ? people.find((x) => x.user.id === owner)?.user : undefined;

  return (
    <>
      <PageHeader
        title="Goals"
        description="Daily, weekly and monthly goals that roll up into each other"
        actions={
          <Button variant="primary" onClick={() => setDialog({})}>
            <Plus className="size-4" />
            New goal
          </Button>
        }
      />

      <Tabs value={period} onChange={setPeriod} tabs={GOAL_PERIODS.map((x) => ({ value: x, label: PERIOD_LABEL[x] }))} />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="Whose goals">
          {(['me', 'team'] as const).map((o) => {
            const active = o === 'me' ? owner === 'me' : owner !== 'me';
            return (
              <button
                key={o}
                aria-pressed={active}
                onClick={() => setOwner(o)}
                className={cx('h-7 rounded px-3 text-xs font-medium', active ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}
              >
                {o === 'me' ? 'Mine' : 'Team'}
              </button>
            );
          })}
        </div>
        {isManager && owner !== 'me' && (
          <Select className="h-8 w-auto text-xs" aria-label="Show goals for" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="team">Everyone</option>
            {isObjectId(owner) && !selectedPerson && <option value={owner}>Selected person</option>}
            {people.map((x) => (
              <option key={x.user.id} value={x.user.id}>
                {x.user.name}
              </option>
            ))}
          </Select>
        )}

        <div className="ml-auto flex items-center gap-2">
          {(list.isFetching || summary.isFetching) && <Spinner className="size-3.5" />}
          <span className="text-sm font-medium" aria-live="polite">
            {p ? periodLabel(p) : '…'}
          </span>
          <Button size="sm" variant="ghost" aria-label={`Previous ${PERIOD_NOUN[period]}`} disabled={!p} onClick={() => p && goToDate(prevPeriodDate(p))}>
            <ChevronLeft className="size-4" />
          </Button>
          <Button size="sm" onClick={() => goToDate(null)} disabled={isCurrent}>
            This {PERIOD_NOUN[period]}
          </Button>
          <Button size="sm" variant="ghost" aria-label={`Next ${PERIOD_NOUN[period]}`} disabled={!p} onClick={() => p && goToDate(nextPeriodDate(p))}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      {summary.data && <SummaryStrip summary={summary.data} meId={me?.id} showPeople={isManager && owner !== 'me'} onPick={setOwner} />}

      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorNote>{errorMessage(list.error)}</ErrorNote>
      ) : items.length === 0 ? (
        <EmptyState
          title={`No ${PERIOD_LABEL[period].toLowerCase()} goals ${isCurrent ? `this ${PERIOD_NOUN[period]}` : `for this ${PERIOD_NOUN[period]}`}`}
          description={owner === 'me' ? 'Set a goal to keep yourself on track.' : 'Nobody has set goals for this period yet.'}
          action={
            <Button onClick={() => setDialog({})}>
              <Plus className="size-4" />
              New goal
            </Button>
          }
        />
      ) : owner === 'team' ? (
        <div className="space-y-8">
          {SCOPE_SECTIONS.map(({ scope, title }) => {
            const group = items.filter((g) => g.scope === scope);
            if (!group.length) return null;
            return (
              <section key={scope} aria-label={title}>
                <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
                  {title}
                  <span className="text-xs text-subtle tabular-nums">{group.length}</span>
                </h2>
                <GoalGrid goals={group} showOwner={showOwner} onOpen={openGoal} />
              </section>
            );
          })}
        </div>
      ) : (
        <GoalGrid goals={items} showOwner={showOwner} onOpen={openGoal} />
      )}

      {list.data?.nextCursor && <p className="mt-4 text-xs text-subtle">Showing the first {items.length} goals.</p>}

      <GoalDialog
        open={!!dialog}
        onClose={() => setDialog(null)}
        period={dialog?.goal?.period ?? period}
        date={p?.start ?? date}
        goal={dialog?.goal}
        onCreated={(g) => openGoal(g.id)}
      />
      <GoalSheet goalId={openGoalId} onClose={() => openGoal(null)} onOpenGoal={openGoal} onEdit={(g) => setDialog({ goal: g })} />
    </>
  );
}

function GoalGrid({ goals, showOwner, onOpen }: { goals: GoalDto[]; showOwner: boolean; onOpen: (id: string) => void }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {goals.map((g) => (
        <GoalCard key={g.id} goal={g} showOwner={showOwner} onOpen={onOpen} />
      ))}
    </div>
  );
}

function SummaryStrip({
  summary,
  meId,
  showPeople,
  onPick,
}: {
  summary: GoalSummaryDto;
  meId: string | undefined;
  showPeople: boolean;
  onPick: (ownerId: string) => void;
}) {
  const mine = summary.people.find((x) => x.user.id === meId) ?? { goals: 0, achieved: 0, avgProgress: 0 };
  const tiles = [
    { label: 'My goals', value: `${mine.achieved} / ${mine.goals}`, hint: 'achieved', pct: mine.avgProgress },
    { label: 'Team goals', value: `${summary.team.achieved} / ${summary.team.goals}`, hint: 'achieved', pct: summary.team.avgProgress },
  ];
  return (
    <section aria-label="Summary" className="mb-8">
      <div className="grid gap-3 sm:grid-cols-2">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border border-border px-4 py-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-muted">{t.label}</span>
              <span className="text-xs text-subtle tabular-nums">avg {t.pct}%</span>
            </div>
            <p className="mt-1 text-lg font-medium tabular-nums">
              {t.value} <span className="text-xs font-normal text-subtle">{t.hint}</span>
            </p>
            <ProgressBar pct={t.pct} label={`${t.label} average progress`} className="mt-2" />
          </div>
        ))}
      </div>

      {showPeople && summary.people.length > 0 && (
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
          {summary.people.map((x) => (
            <li key={x.user.id}>
              <button onClick={() => onPick(x.user.id)} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-hover">
                <Avatar name={x.user.name} size={20} />
                <span className="min-w-0 flex-1 truncate text-sm">{x.user.name}</span>
                <span className="text-xs text-subtle tabular-nums">
                  {x.achieved}/{x.goals}
                </span>
                <ProgressBar pct={x.avgProgress} label={`${x.user.name} average progress`} className="w-24" />
                <span className="w-9 text-right text-xs text-muted tabular-nums">{x.avgProgress}%</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
