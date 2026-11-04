import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CornerLeftUp, Forward, Pencil, RotateCcw, Trash2, X } from 'lucide-react';
import { hasRoleAtLeast, type GoalDetailDto, type GoalDto } from '@teamtrack/shared';
import { goalsApi } from '../../api/goals';
import { tasksApi } from '../../api/endpoints';
import { errorMessage, problemOf } from '../../lib/errors';
import {
  canCarryOver,
  gk,
  goalErrorHandler,
  goalPeriodShort,
  isClosed,
  latestGoal,
  MEASURE_LABEL,
  PERIOD_LABEL,
  PERIOD_NOUN,
  refreshGoals,
  SCOPE_LABEL,
  syncGoal,
  useGoalDetail,
  valueText,
} from '../../lib/goals';
import { useDebounced } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/toast';
import { Avatar, Badge, Button, cx, EmptyState, ErrorNote, Input, Sheet, Spinner } from '../ui';
import { GoalProgressControl, GoalStatusBadge, ProgressBar } from './GoalBits';

/** Goal detail in a side sheet: progress, key results, roll-up (parent and children), carry-over trail and linked tasks. */
export function GoalSheet({
  goalId,
  onClose,
  onOpenGoal,
  onEdit,
}: {
  goalId: string | null;
  onClose: () => void;
  onOpenGoal: (id: string) => void;
  onEdit: (g: GoalDto) => void;
}) {
  return (
    <Sheet open={!!goalId} onClose={onClose} label="Goal details">
      {goalId && <GoalSheetBody key={goalId} goalId={goalId} onClose={onClose} onOpenGoal={onOpenGoal} onEdit={onEdit} />}
    </Sheet>
  );
}

function GoalSheetBody({ goalId, onClose, onOpenGoal, onEdit }: { goalId: string; onClose: () => void; onOpenGoal: (id: string) => void; onEdit: (g: GoalDto) => void }) {
  const goal = useGoalDetail(goalId);

  if (goal.isPending) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }
  if (goal.isError) {
    return (
      <div className="space-y-4 p-6">
        {problemOf(goal.error)?.status === 404 ? (
          <EmptyState title="Goal not found" description="It may have been deleted, or you don't have access" />
        ) : (
          <ErrorNote>{errorMessage(goal.error)}</ErrorNote>
        )}
        <Button onClick={onClose}>Close</Button>
      </div>
    );
  }
  return <GoalDetail goal={goal.data} onClose={onClose} onOpenGoal={onOpenGoal} onEdit={onEdit} />;
}

function GoalDetail({ goal: g, onClose, onOpenGoal, onEdit }: { goal: GoalDetailDto; onClose: () => void; onOpenGoal: (id: string) => void; onEdit: (g: GoalDto) => void }) {
  const qc = useQueryClient();
  const role = useAuth((s) => s.user?.role ?? 'guest');
  const onError = goalErrorHandler(qc);
  const closed = isClosed(g);
  const canDelete = g.canEdit || hasRoleAtLeast(role, 'admin');

  const parent = useQuery({
    queryKey: gk.goal(g.parentGoalId ?? ''),
    queryFn: () => goalsApi.get(g.parentGoalId!),
    enabled: !!g.parentGoalId,
    retry: false,
  });

  const setStatus = useMutation({
    mutationFn: (status: 'active' | 'cancelled') => goalsApi.update(g.id, { status }, latestGoal(qc, g).version),
    onSuccess: (x) => {
      syncGoal(qc, x);
      toast(x.status === 'cancelled' ? 'Goal cancelled' : 'Goal reopened');
    },
    onError,
  });
  const carry = useMutation({
    mutationFn: () => goalsApi.carryOver(g.id),
    onSuccess: (copy) => {
      refreshGoals(qc);
      toast(`Carried over to the next ${PERIOD_NOUN[g.period]}`);
      onOpenGoal(copy.id);
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => goalsApi.remove(g.id),
    onSuccess: () => {
      qc.removeQueries({ queryKey: gk.goal(g.id) });
      refreshGoals(qc);
      toast('Goal deleted');
      onClose();
    },
    onError,
  });

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-5">
        <span className="text-xs text-muted">
          {PERIOD_LABEL[g.period]} · {goalPeriodShort(g)}
        </span>
        {g.scope !== 'personal' && <Badge>{SCOPE_LABEL[g.scope]}</Badge>}
        <div className="ml-auto flex items-center gap-1">
          {g.canEdit && !closed && (
            <button onClick={() => onEdit(g)} className="rounded p-1.5 text-muted hover:bg-hover" aria-label="Edit goal" title="Edit goal">
              <Pencil className="size-4" />
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => window.confirm(`Delete "${g.title}"? Goals that roll up into it are kept.`) && remove.mutate()}
              disabled={remove.isPending}
              className="rounded p-1.5 text-muted hover:bg-hover hover:text-danger"
              aria-label="Delete goal"
              title="Delete goal"
            >
              <Trash2 className="size-4" />
            </button>
          )}
          <button onClick={onClose} className="rounded p-1.5 text-muted hover:bg-hover" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
      </header>

      <div className="flex-1 space-y-7 overflow-y-auto px-5 py-5">
        <section>
          <div className="flex items-start gap-3">
            <h2 className={cx('min-w-0 flex-1 text-lg font-medium', g.status === 'cancelled' && 'line-through')}>{g.title}</h2>
            <GoalStatusBadge status={g.status} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {g.owner && (
              <span className="inline-flex items-center gap-1.5">
                <Avatar name={g.owner.name} size={18} />
                {g.owner.name}
              </span>
            )}
            <span>{g.keyResults.length ? 'Key results' : MEASURE_LABEL[g.measure]}</span>
            {g.projectId && (
              <Link to={`/projects/${g.projectId}`} className="hover:underline">
                Open project
              </Link>
            )}
          </div>
          {g.description && <p className="mt-3 text-sm whitespace-pre-wrap text-muted">{g.description}</p>}
        </section>

        <section className="space-y-3">
          <div className="flex items-center gap-3">
            <ProgressBar pct={g.progressPct} status={g.status} label="Goal progress" />
            <span className="shrink-0 text-sm font-medium tabular-nums">{g.progressPct}%</span>
          </div>
          <p className="text-xs text-subtle">{valueText(g)}</p>
          <GoalProgressControl goal={g} />
        </section>

        {g.canEdit && (
          <section className="flex flex-wrap gap-2">
            {canCarryOver(g) && (
              <Button size="sm" loading={carry.isPending} onClick={() => carry.mutate()}>
                <Forward className="size-3.5" />
                Carry over to next {PERIOD_NOUN[g.period]}
              </Button>
            )}
            {g.status === 'cancelled' ? (
              <Button size="sm" loading={setStatus.isPending} onClick={() => setStatus.mutate('active')}>
                <RotateCcw className="size-3.5" />
                Reopen
              </Button>
            ) : (
              g.status !== 'carried_over' && (
                <Button size="sm" variant="ghost" loading={setStatus.isPending} onClick={() => window.confirm('Cancel this goal?') && setStatus.mutate('cancelled')}>
                  <Ban className="size-3.5" />
                  Cancel goal
                </Button>
              )
            )}
          </section>
        )}

        {(g.parentGoalId || g.carriedFromId || g.carriedToId) && (
          <section className="space-y-1.5 text-sm">
            {g.parentGoalId && (
              <p className="flex items-center gap-1.5 text-muted">
                <CornerLeftUp className="size-3.5" aria-hidden />
                Rolls up into{' '}
                <button className="text-fg hover:underline" onClick={() => onOpenGoal(g.parentGoalId!)}>
                  {parent.data ? parent.data.title : parent.isError ? 'a goal you can’t see' : '…'}
                </button>
              </p>
            )}
            {g.carriedFromId && (
              <p className="text-muted">
                Carried over from{' '}
                <button className="text-fg hover:underline" onClick={() => onOpenGoal(g.carriedFromId!)}>
                  the previous {PERIOD_NOUN[g.period]}
                </button>
              </p>
            )}
            {g.carriedToId && (
              <p className="text-muted">
                Carried over to{' '}
                <button className="text-fg hover:underline" onClick={() => onOpenGoal(g.carriedToId!)}>
                  the next {PERIOD_NOUN[g.period]}
                </button>
              </p>
            )}
          </section>
        )}

        {g.children.length > 0 && (
          <section>
            <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted">
              Rolls up from
              <span className="text-subtle tabular-nums">{g.children.length}</span>
            </h3>
            <ul className="divide-y divide-border rounded-md border border-border">
              {g.children.map((c) => (
                <li key={c.id}>
                  <button onClick={() => onOpenGoal(c.id)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-hover">
                    <span className="min-w-0 flex-1">
                      <span className={cx('block truncate text-sm', c.status === 'cancelled' && 'line-through')}>{c.title}</span>
                      <span className="block text-2xs text-subtle">
                        {goalPeriodShort(c)}
                        {c.owner ? ` · ${c.owner.name}` : ''}
                      </span>
                    </span>
                    <ProgressBar pct={c.progressPct} status={c.status} label={`${c.title} progress`} className="w-20" />
                    <span className="w-9 text-right text-xs text-muted tabular-nums">{c.progressPct}%</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <LinkedTasks goal={g} editable={g.canEdit && !closed} />
      </div>
    </div>
  );
}

function LinkedTasks({ goal: g, editable }: { goal: GoalDetailDto; editable: boolean }) {
  const qc = useQueryClient();
  const onError = goalErrorHandler(qc);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const results = useQuery({
    queryKey: ['tasks', 'goal-link-search', q],
    queryFn: () => tasksApi.list({ q, limit: 8, state: 'all' }),
    enabled: editable && q.length > 0,
  });
  const afterChange = (x: GoalDto) => {
    syncGoal(qc, x);
    // Linked task summaries only come with the detail.
    void qc.invalidateQueries({ queryKey: gk.goal(g.id) });
  };
  const link = useMutation({
    mutationFn: (taskId: string) => goalsApi.linkTask(g.id, taskId),
    onSuccess: (x) => {
      setSearch('');
      afterChange(x);
    },
    onError,
  });
  const unlink = useMutation({ mutationFn: (taskId: string) => goalsApi.unlinkTask(g.id, taskId), onSuccess: afterChange, onError });
  const linkedIds = new Set(g.linkedTaskIds);
  const candidates = (results.data?.items ?? []).filter((x) => !linkedIds.has(x.id));
  const hidden = g.linkedTaskIds.length - g.linkedTasks.length;

  if (!editable && g.linkedTasks.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted">
        Linked tasks
        {g.linkedTasks.length > 0 && (
          <span className="text-subtle tabular-nums">
            {g.tasks.done}/{g.tasks.total} done
          </span>
        )}
      </h3>
      {g.measure === 'tasks' && !g.keyResults.length && g.linkedTasks.length === 0 && (
        <p className="mb-2 text-xs text-subtle">Progress follows these tasks as they're completed</p>
      )}
      {g.linkedTasks.length > 0 && (
        <ul className="mb-2 divide-y divide-border rounded-md border border-border">
          {g.linkedTasks.map((t) => (
            <li key={t.id} className="group flex items-center gap-2.5 px-3 py-2">
              <span aria-hidden className={cx('size-2 shrink-0 rounded-full', t.statusCategory === 'done' ? 'bg-success' : t.statusCategory === 'in_progress' ? 'bg-fg' : 'bg-subtle')} />
              <Link
                to={`/projects/${t.projectId}?task=${t.id}`}
                className={cx('min-w-0 flex-1 truncate text-sm hover:underline', t.statusCategory === 'done' && 'text-muted line-through')}
              >
                {t.title}
              </Link>
              <span className="job-tag">{t.key}</span>
              {editable && (
                <button
                  onClick={() => unlink.mutate(t.id)}
                  disabled={unlink.isPending}
                  className="rounded p-0.5 text-subtle opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100"
                  aria-label={`Unlink ${t.key}`}
                >
                  <X className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && <p className="mb-2 text-xs text-subtle">{hidden} linked task{hidden === 1 ? '' : 's'} in projects you can't see.</p>}
      {editable && (
        <div className="relative">
          <Input
            className="h-8"
            placeholder="Link a task: search title or key"
            aria-label="Search tasks to link"
            value={search}
            maxLength={100}
            onChange={(e) => setSearch(e.target.value)}
          />
          {q && (
            <ul className="absolute inset-x-0 top-full z-10 mt-1 max-h-60 overflow-y-auto rounded-md border border-border bg-bg py-1 shadow-lg">
              {results.isPending ? (
                <li className="px-3 py-2">
                  <Spinner />
                </li>
              ) : candidates.length === 0 ? (
                <li className="px-3 py-2 text-xs text-muted">No matching tasks</li>
              ) : (
                candidates.map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => link.mutate(c.id)}
                      disabled={link.isPending}
                      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-hover"
                    >
                      <span className="w-16 shrink-0"><span className="job-tag">{c.key}</span></span>
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
