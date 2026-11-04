import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CornerLeftUp, Forward, Link2 } from 'lucide-react';
import type { GoalDto } from '@teamtrack/shared';
import { goalsApi } from '../../api/goals';
import { canCarryOver, goalErrorHandler, PERIOD_NOUN, refreshGoals, SCOPE_LABEL } from '../../lib/goals';
import { toast } from '../../stores/toast';
import { Avatar, Badge, Button, cx } from '../ui';
import { GoalProgressControl, GoalStatusBadge, ProgressBar } from './GoalBits';

/** One goal in the list: title (opens the detail sheet), status, progress bar and the inline progress control. */
export function GoalCard({ goal: g, showOwner, onOpen }: { goal: GoalDto; showOwner: boolean; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const carry = useMutation({
    mutationFn: () => goalsApi.carryOver(g.id),
    onSuccess: () => {
      refreshGoals(qc);
      toast(`Carried over to the next ${PERIOD_NOUN[g.period]}`);
    },
    onError: goalErrorHandler(qc),
  });
  const dim = g.status === 'cancelled' || g.status === 'carried_over';

  return (
    <article className={cx('rounded-lg border border-border p-4', dim && 'opacity-70')} aria-labelledby={`goal-${g.id}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id={`goal-${g.id}`} className="text-sm font-medium">
            <button onClick={() => onOpen(g.id)} className={cx('text-left hover:underline', g.status === 'cancelled' && 'line-through')}>
              {g.title}
            </button>
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
            {g.scope !== 'personal' && <Badge>{SCOPE_LABEL[g.scope]}</Badge>}
            {showOwner && g.owner && (
              <span className="inline-flex items-center gap-1.5">
                <Avatar name={g.owner.name} size={16} />
                {g.owner.name}
              </span>
            )}
            {g.parentGoalId && (
              <span className="inline-flex items-center gap-1" title="Rolls up into a bigger goal">
                <CornerLeftUp className="size-3" aria-hidden />
                Rolls up
              </span>
            )}
            {g.linkedTaskIds.length > 0 && (
              <span className="inline-flex items-center gap-1 tabular-nums" title="Linked tasks">
                <Link2 className="size-3" aria-hidden />
                {g.tasks.done}/{g.tasks.total}
              </span>
            )}
            {g.carriedFromId && <span>Carried over</span>}
          </div>
        </div>
        <GoalStatusBadge status={g.status} />
      </div>

      <div className="mt-3 flex items-center gap-3">
        <ProgressBar pct={g.progressPct} status={g.status} label={`${g.title} progress`} />
        <span className="w-9 shrink-0 text-right text-xs text-muted tabular-nums">{g.progressPct}%</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <GoalProgressControl goal={g} />
        </div>
        {canCarryOver(g) && (
          <Button size="sm" variant="ghost" loading={carry.isPending} onClick={() => carry.mutate()} title={`Copy what's left into the next ${PERIOD_NOUN[g.period]}`}>
            <Forward className="size-3.5" />
            Carry over
          </Button>
        )}
      </div>
    </article>
  );
}
