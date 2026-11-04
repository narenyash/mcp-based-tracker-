import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { projectsApi, usersApi } from '../api/endpoints';
import { reportKeys, reportsApi } from '../api/reports';
import { errorMessage } from '../lib/errors';
import { useAuth } from '../stores/auth';
import { EmptyState, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { myWorkQueries } from '../lib/tasks';
import { StatGrid, VizStyle } from '../components/reports/charts';
import { DueSoon } from '../components/dashboard/DueSoon';
import { MyGoals } from '../components/dashboard/MyGoals';
import { RecentActivity } from '../components/dashboard/RecentActivity';
import { gameKeys, gamesApi } from '../api/games';
import { SnakeGame } from '../components/snake/SnakeGame';
import { SnakeLeaderboard } from '../components/snake/SnakeLeaderboard';

const todayTitle = () => new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
/** "2026-11-08" -> "Sun, Nov 8" (a calendar day, so read as UTC). */
const shortDay = (ymd: string) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

function Section({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className} aria-label={title}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const sectionLink = (to: string, label: string) => (
  <Link to={to} className="flex items-center gap-1 text-xs text-muted hover:text-fg">
    {label} <ArrowRight className="size-3" />
  </Link>
);

export function DashboardPage() {
  const workspace = useAuth((s) => s.workspace);
  const projects = useQuery({
    queryKey: ['projects', 'active'],
    queryFn: () => projectsApi.list({ status: 'active' }),
  });
  const team = useQuery({ queryKey: ['users', ''], queryFn: () => usersApi.list({ limit: 100 }) });
  const assigned = useQuery(myWorkQueries.assigned);
  const testing = useQuery(myWorkQueries.testing);
  const mine = useQuery({
    queryKey: reportKeys.dashboard,
    queryFn: reportsApi.myDashboard,
    staleTime: 30_000,
  });
  const snake = useQuery({ queryKey: gameKeys.snakeLeaderboard, queryFn: gamesApi.snakeLeaderboard });
  const m = mine.data;
  const count = (p: { items: unknown[]; nextCursor: string | null } | undefined) =>
    p ? `${p.items.length}${p.nextCursor ? '+' : ''}` : undefined;

  return (
    <>
      <PageHeader title={todayTitle()} description={workspace?.name} />

      <VizStyle />
      {mine.isError ? (
        <div className="mb-10">
          <ErrorNote>{errorMessage(mine.error)}</ErrorNote>
        </div>
      ) : !m ? (
        <Spinner className="mb-10" />
      ) : (
        <>
          <StatGrid
            stats={[
              { label: 'Assigned to me', value: count(assigned.data) ?? '–' },
              { label: 'Due this week', value: m.tasks.dueThisWeek, hint: `through ${shortDay(m.weekEnd)}` },
              { label: 'Overdue', value: m.tasks.overdue, alert: m.tasks.overdue > 0 },
              { label: 'Waiting for my testing', value: count(testing.data) ?? '–' },
            ]}
          />
          {/* Secondary counts stay quiet: one line under the tiles, not four more tiles. */}
          <p className="mt-3 mb-10 flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs text-subtle">
            <span>
              <span className="text-fg">{m.tasks.dueToday}</span> due today
            </span>
            <span>
              <span className="text-fg">{m.openTickets}</span> open tickets
            </span>
            {projects.data && (
              <span>
                <span className="text-fg">{projects.data.items.length}</span> {projects.data.items.length === 1 ? 'project' : 'projects'}
              </span>
            )}
            {team.data && (
              <span>
                <span className="text-fg">{team.data.items.length}</span> {team.data.items.length === 1 ? 'person' : 'people'}
              </span>
            )}
          </p>
          <div className="mb-10 grid gap-10 lg:grid-cols-2">
            <Section title="Due soon" action={sectionLink('/my-work', 'My work')}>
              <DueSoon tasks={m.dueSoon} today={m.today} />
            </Section>
            <Section title="My goals" action={sectionLink('/goals', 'All goals')}>
              <MyGoals today={m.goals.today} week={m.goals.week} />
            </Section>
          </div>
          <Section title="Recent activity on your work" className="mb-10">
            <RecentActivity items={m.activity} />
          </Section>
        </>
      )}

      <Section title="Your projects" action={sectionLink('/projects', 'All projects')} className="mb-10">
        {projects.isPending ? (
          <Spinner />
        ) : projects.data?.items.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {projects.data.items.slice(0, 5).map((p) => (
              <li key={p.id}>
                <Link
                  to={`/projects/${p.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-hover"
                >
                  <span className="size-2.5 rounded-full" style={{ background: p.color }} />
                  <span className="text-sm font-medium">{p.name}</span>
                  <span className="font-mono text-xs text-subtle">{p.key}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No projects yet"
            description="Create a project to start organising your team's work"
          />
        )}
      </Section>
      <div className="grid gap-10 lg:grid-cols-3">
        <Section title="Snake" className="lg:col-span-2">
          <SnakeGame best={snake.data?.me?.best ?? null} />
        </Section>
        <Section title="Leaderboard">
          {snake.isError ? <ErrorNote>{errorMessage(snake.error)}</ErrorNote> : snake.data ? <SnakeLeaderboard data={snake.data} /> : <Spinner />}
        </Section>
      </div>
    </>
  );
}
