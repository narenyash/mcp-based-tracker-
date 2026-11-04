import { Link } from 'react-router';
import type { DashboardTaskDto } from '@teamtrack/shared';
import { formatDay } from '../../lib/planning';
import { cx } from '../ui';

/** My open tasks that are overdue or due by the end of this week, soonest first. */
export function DueSoon({ tasks, today }: { tasks: DashboardTaskDto[]; today: string }) {
  if (!tasks.length) return <p className="py-3 text-sm text-muted">Nothing due this week</p>;
  return (
    <ul className="divide-y divide-border">
      {tasks.map((t) => (
        <li key={t.id}>
          <Link
            to={`/projects/${t.projectId}?task=${t.id}`}
            className="-mx-2 flex items-center gap-3 rounded px-2 py-2 hover:bg-hover"
          >
            <span className="w-16 shrink-0"><span className="job-tag">{t.key}</span></span>
            <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
            <time
              dateTime={t.dueDate}
              className={cx(
                'shrink-0 text-xs tabular-nums',
                t.overdue ? 'text-danger' : 'text-muted',
              )}
            >
              {t.overdue ? 'Overdue · ' : ''}
              {t.dueDate === today
                ? 'Today'
                : formatDay(t.dueDate, { weekday: 'short', month: 'short', day: 'numeric' })}
            </time>
          </Link>
        </li>
      ))}
    </ul>
  );
}
