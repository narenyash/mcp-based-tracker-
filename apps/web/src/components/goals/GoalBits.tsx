import { useEffect, useRef, useState } from 'react';
import { Check, Minus, Plus } from 'lucide-react';
import type { GoalDto, GoalProgressInput, GoalStatus } from '@teamtrack/shared';
import { isClosed, STATUS_CLASS, STATUS_LABEL, useGoalProgress } from '../../lib/goals';
import { Badge, cx } from '../ui';

export function GoalStatusBadge({ status }: { status: GoalStatus }) {
  return <Badge className={cx(STATUS_CLASS[status], status === 'cancelled' && 'line-through')}>{STATUS_LABEL[status]}</Badge>;
}

export function ProgressBar({ pct, status, label, className }: { pct: number; status?: GoalStatus; label: string; className?: string }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v}
      className={cx('h-1.5 w-full overflow-hidden rounded-full bg-hover', className)}
    >
      <div
        className={cx(
          'h-full rounded-full transition-transform duration-300 ease-(--ease-out)',
          status === 'achieved' ? 'bg-success' : status === 'missed' ? 'bg-danger' : status && isClosed({ status }) ? 'bg-subtle' : 'bg-ink',
        )}
        style={{ transform: `translateX(${v - 100}%)` }}
      />
    </div>
  );
}

/**
 * Number input with -/+ buttons. Clicks are batched: the value commits 600ms after the last click
 * (or on blur / Enter when typing), so a run of clicks is one request and one version bump.
 */
export function NumberStepper({
  value,
  onCommit,
  step = 1,
  max,
  disabled,
  label,
  suffix,
}: {
  value: number;
  onCommit: (n: number) => void;
  step?: number;
  max?: number;
  disabled?: boolean;
  label: string;
  suffix?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setDraft(String(value)), [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const clamp = (n: number) => Math.max(0, max === undefined ? n : Math.min(max, n));
  const commit = (raw: string) => {
    window.clearTimeout(timer.current);
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const c = clamp(Math.round(n * 100) / 100);
    setDraft(String(c));
    if (c !== value) onCommit(c);
  };
  const bump = (d: number) => {
    const n = clamp((Number(draft) || 0) + d);
    setDraft(String(n));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => commit(String(n)), 600);
  };

  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => bump(-step)}
        disabled={disabled || Number(draft) <= 0}
        className="rounded p-1 text-muted hover:bg-hover disabled:opacity-40"
        aria-label={`Decrease ${label}`}
      >
        <Minus className="size-3.5" />
      </button>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        {...(max !== undefined ? { max } : {})}
        step="any"
        value={draft}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && commit(e.currentTarget.value)}
        className="h-7 w-16 rounded-md border border-border bg-bg px-1.5 text-center text-sm tabular-nums focus:border-fg focus:outline-none disabled:opacity-60 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
      <button
        type="button"
        onClick={() => bump(step)}
        disabled={disabled || (max !== undefined && Number(draft) >= max)}
        className="rounded p-1 text-muted hover:bg-hover disabled:opacity-40"
        aria-label={`Increase ${label}`}
      >
        <Plus className="size-3.5" />
      </button>
      {suffix && <span className="ml-0.5 text-xs text-muted tabular-nums">{suffix}</span>}
    </div>
  );
}

/** The inline progress control for a goal: a toggle, a stepper, key-result steppers or (for task goals) a count. */
export function GoalProgressControl({ goal }: { goal: GoalDto }) {
  const progress = useGoalProgress();
  const editable = goal.canEdit && !isClosed(goal);
  const set = (input: GoalProgressInput) => progress.mutate({ goal, input });

  if (goal.keyResults.length) {
    return (
      <ul className="space-y-2">
        {goal.keyResults.map((kr) => (
          <li key={kr.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 flex-1 truncate text-sm" title={kr.title}>
              {kr.title}
            </span>
            {editable ? (
              <NumberStepper
                value={kr.current}
                label={`${kr.title} progress`}
                suffix={`/ ${kr.target}${kr.unit ? ` ${kr.unit}` : ''}`}
                onCommit={(current) => set({ keyResults: [{ id: kr.id, current }] })}
              />
            ) : (
              <span className="text-xs text-muted tabular-nums">
                {kr.current} / {kr.target}
                {kr.unit ? ` ${kr.unit}` : ''}
              </span>
            )}
            <ProgressBar pct={(kr.target > 0 ? Math.min(1, kr.current / kr.target) : 0) * 100} label={`${kr.title} progress`} className="basis-full" />
          </li>
        ))}
      </ul>
    );
  }

  switch (goal.measure) {
    case 'boolean': {
      const done = goal.current >= 1;
      return (
        <button
          type="button"
          role="checkbox"
          aria-checked={done}
          disabled={!editable}
          onClick={() => set({ current: done ? 0 : 1 })}
          className="inline-flex items-center gap-2 rounded-md py-0.5 text-sm text-muted hover:text-fg disabled:pointer-events-none"
        >
          <span
            aria-hidden
            className={cx('inline-flex size-4 items-center justify-center rounded border', done ? 'border-success bg-success text-bg' : 'border-border')}
          >
            {done && <Check className="size-3" strokeWidth={3} />}
          </span>
          {done ? 'Done' : editable ? 'Mark as done' : 'Not done'}
        </button>
      );
    }
    case 'number':
      return editable ? (
        <NumberStepper
          value={goal.current}
          label="Progress"
          suffix={`/ ${goal.target}${goal.unit ? ` ${goal.unit}` : ''}`}
          onCommit={(current) => set({ current })}
        />
      ) : (
        <span className="text-xs text-muted tabular-nums">
          {goal.current} / {goal.target}
          {goal.unit ? ` ${goal.unit}` : ''}
        </span>
      );
    case 'percent':
      return editable ? (
        <NumberStepper value={goal.current} step={10} max={100} label="Percent complete" suffix="%" onCommit={(current) => set({ current })} />
      ) : (
        <span className="text-xs text-muted tabular-nums">{goal.current}%</span>
      );
    case 'tasks':
      return (
        <span className="text-xs text-muted tabular-nums">
          {goal.tasks.total ? `${goal.tasks.done} of ${goal.tasks.total} linked task${goal.tasks.total === 1 ? '' : 's'} done` : 'No linked tasks yet'}
        </span>
      );
  }
}
