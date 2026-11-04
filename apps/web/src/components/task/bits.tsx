import { CalendarDays, CircleAlert, FlaskConical, Minus } from 'lucide-react';
import type { LabelDto, TaskDto, TaskPriority, TestingDto } from '@teamtrack/shared';
import { formatDue, isOverdue } from '../../lib/tasks';
import { cx } from '../ui';

export const PRIORITY_LABEL: Record<TaskPriority, string> = { none: 'No priority', low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };

export function PriorityIcon({ priority, className }: { priority: TaskPriority; className?: string }) {
  const props = { className: cx('size-3.5 shrink-0', className), strokeWidth: 2, 'aria-label': PRIORITY_LABEL[priority] };
  switch (priority) {
    case 'urgent':
      return <CircleAlert {...props} className={cx(props.className, 'text-danger')} />;
    case 'high':
      return <PriorityBars filled={3} label={PRIORITY_LABEL[priority]} className={className} />;
    case 'medium':
      return <PriorityBars filled={2} label={PRIORITY_LABEL[priority]} className={className} />;
    case 'low':
      return <PriorityBars filled={1} label={PRIORITY_LABEL[priority]} className={className} />;
    default:
      return <Minus {...props} className={cx(props.className, 'text-subtle')} />;
  }
}

/** Three rising bars; the unfilled ones stay visible as hairlines so the level reads at a glance. */
function PriorityBars({ filled, label, className }: { filled: number; label: string; className?: string | undefined }) {
  return (
    <svg viewBox="0 0 14 14" role="img" aria-label={label} className={cx('size-3.5 shrink-0', className)}>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={1 + i * 4.5}
          y={10 - i * 3.5}
          width={3}
          height={3 + i * 3.5}
          rx={0.75}
          className={i < filled ? 'fill-muted' : 'fill-border'}
        />
      ))}
    </svg>
  );
}

export function StatusDot({ color }: { color: string }) {
  return <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />;
}

export function LabelChip({ label }: { label: LabelDto }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-px text-2xs text-muted">
      <span className="size-1.5 rounded-full" style={{ background: label.color }} />
      {label.name}
    </span>
  );
}

export function DueDate({ task }: { task: Pick<TaskDto, 'dueDate' | 'statusCategory'> }) {
  if (!task.dueDate) return null;
  const overdue = isOverdue(task);
  return (
    <span className={cx('inline-flex items-center gap-1 text-2xs', overdue ? 'text-danger' : 'text-muted')} title={overdue ? 'Overdue' : 'Due date'}>
      <CalendarDays className="size-3" />
      {formatDue(task.dueDate)}
    </span>
  );
}

const RESULT_STYLE: Record<TestingDto['result'], string> = {
  pending: 'text-amber-600 dark:text-amber-400',
  passed: 'text-success',
  failed: 'text-danger',
};

/** Compact testing state for cards and rows: "Testing · Arjun · round 2", or the last result. */
export function TestingBadge({ task }: { task: Pick<TaskDto, 'testing' | 'tester' | 'statusCategory'> }) {
  if (!task.testing) return null;
  const { result, round } = task.testing;
  // A pass is only interesting while it's fresh; hide it once the task leaves Done.
  if (result === 'passed' && task.statusCategory !== 'done') return null;
  const text = result === 'pending' ? `Testing · ${task.tester?.name.split(' ')[0] ?? '?'}` : result === 'passed' ? 'Passed testing' : 'Failed testing';
  return (
    <span className={cx('inline-flex items-center gap-1 text-2xs font-medium', RESULT_STYLE[result])}>
      <FlaskConical className="size-3" />
      {text}
      {round > 1 && <span className="font-normal text-subtle">· round {round}</span>}
    </span>
  );
}
