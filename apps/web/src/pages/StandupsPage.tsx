import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, ChevronLeft, ChevronRight } from 'lucide-react';
import { standupsApi } from '../api/planning';
import { errorMessage } from '../lib/errors';
import { addDays, formatDay, planningKeys } from '../lib/planning';
import { useAuth } from '../stores/auth';
import { Avatar, Button, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { StandupForm } from '../components/planning/StandupForm';
import { StandupEntry } from '../components/planning/StandupEntry';

const isDateKey = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Phase 8: my standup for today + team feed. */
export function StandupsPage() {
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const [params, setParams] = useSearchParams();
  const dateParam = params.get('date');
  const date = isDateKey(dateParam) ? dateParam : undefined;
  // Bumped after a conflicting save so the form re-reads the server's version.
  const [formEpoch, setFormEpoch] = useState(0);

  const feed = useQuery({
    queryKey: planningKeys.standupFeed(date, undefined),
    queryFn: () => standupsApi.feed({ date }),
    placeholderData: keepPreviousData,
  });

  const today = feed.data?.today;
  const shown = date ?? today;
  const goTo = (d: string | null) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (!d || d === today) next.delete('date');
      else next.set('date', d);
      return next;
    });

  const onConflict = async () => {
    await qc.invalidateQueries({ queryKey: planningKeys.standups });
    setFormEpoch((n) => n + 1);
  };

  const f = feed.data;
  const others = f?.entries.filter((e) => e.user.id !== me?.id) ?? [];
  const waiting = f?.notPosted.filter((p) => p.id !== me?.id) ?? [];
  const isToday = !!f && f.date === f.today;

  return (
    <>
      <PageHeader title="Standups" description="What everyone did, is doing, and what's in the way" />

      {f?.nudge && (
        <div className="mb-6 flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm" role="status">
          <BellRing className="size-4 shrink-0 text-muted" strokeWidth={1.75} />
          <span className="flex-1">You haven't posted today's standup yet. The team checks in at {f.standupTime}.</span>
          {!isToday && (
            <Button size="sm" variant="ghost" onClick={() => goTo(null)}>
              Write it
            </Button>
          )}
        </div>
      )}

      <div className="mb-6 flex items-center gap-2">
        <h2 className="mr-auto text-base font-medium">
          {shown ? formatDay(shown, { weekday: 'long', month: 'long', day: 'numeric' }) : '…'}
          {isToday && <span className="ml-2 text-xs font-normal text-subtle">Today</span>}
        </h2>
        {feed.isFetching && <Spinner className="size-3.5" />}
        <Button size="sm" variant="ghost" aria-label="Previous day" disabled={!shown} onClick={() => shown && goTo(addDays(shown, -1))}>
          <ChevronLeft className="size-4" />
        </Button>
        <Button size="sm" onClick={() => goTo(null)} disabled={isToday}>
          Today
        </Button>
        <Button size="sm" variant="ghost" aria-label="Next day" disabled={!shown || isToday} onClick={() => shown && goTo(addDays(shown, 1))}>
          <ChevronRight className="size-4" />
        </Button>
      </div>

      {feed.isPending ? (
        <Spinner />
      ) : feed.isError ? (
        <ErrorNote>{errorMessage(feed.error)}</ErrorNote>
      ) : (
        <>
          <section className="mb-10 rounded-lg border border-border p-5">
            <h3 className="mb-4 text-sm font-medium">My standup</h3>
            {f!.editable ? (
              <StandupForm key={`${f!.date}:${formEpoch}`} date={f!.date} mine={f!.mine} onConflict={() => void onConflict()} />
            ) : f!.mine ? (
              <StandupEntry entry={f!.mine} />
            ) : (
              <p className="text-sm text-muted">You didn't post a standup on this day</p>
            )}
          </section>

          <section>
            <h3 className="mb-1 flex items-center gap-2 text-sm font-medium">
              Team
              {others.length > 0 && <span className="text-xs text-subtle tabular-nums">{others.length}</span>}
            </h3>
            {others.length ? (
              <div className="divide-y divide-border">
                {others.map((e) => (
                  <StandupEntry key={e.id} entry={e} />
                ))}
              </div>
            ) : (
              <p className="py-3 text-sm text-muted">No one else has posted{isToday ? ' yet' : ''}.</p>
            )}

            {waiting.length > 0 && (
              <div className="mt-6 border-t border-border pt-4">
                <p className="mb-2 text-xs font-medium text-subtle">{isToday ? 'Not posted yet' : "Didn't post"}</p>
                <ul className="flex flex-wrap gap-1.5">
                  {waiting.map((p) => (
                    <li key={p.id} title={p.name} className="flex items-center gap-1.5 rounded-full border border-border py-0.5 pr-2.5 pl-0.5">
                      <Avatar name={p.name} size={20} />
                      <span className="text-xs text-muted">{p.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
