import { Link } from 'react-router';
import type { DashboardGoalsDto } from '@teamtrack/shared';
import { Meter } from '../reports/charts';

function Period({ title, goals }: { title: string; goals: DashboardGoalsDto }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium text-muted">{title}</h3>
        {goals.total > 0 && (
          <span className="text-xs text-subtle tabular-nums">
            {goals.achieved}/{goals.total} done · {goals.avgProgress}%
          </span>
        )}
      </div>
      {goals.total === 0 ? (
        <p className="text-sm text-subtle">No goals set</p>
      ) : (
        <ul className="space-y-2.5">
          {goals.items.map((g) => (
            <li key={g.id}>
              <Link to={`/goals?goal=${g.id}`} className="block rounded hover:bg-hover">
                <div className="mb-1 flex justify-between gap-3 text-sm">
                  <span className="truncate">{g.title}</span>
                  <span className="shrink-0 text-xs text-muted tabular-nums">{g.progressPct}%</span>
                </div>
                <Meter value={g.progressPct} label={`${g.title} progress`} />
              </Link>
            </li>
          ))}
          {goals.total > goals.items.length && (
            <li className="text-xs text-subtle">+{goals.total - goals.items.length} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

/** My goals for today and this week (lowest progress first). */
export function MyGoals({ today, week }: { today: DashboardGoalsDto; week: DashboardGoalsDto }) {
  return (
    <div className="space-y-5">
      <Period title="Today" goals={today} />
      <Period title="This week" goals={week} />
    </div>
  );
}
