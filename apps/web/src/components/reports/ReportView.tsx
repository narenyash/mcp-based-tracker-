import type {
  ReportGoalPeriodDto,
  StatusCategory,
  TeamReportDto,
  TicketSeverity,
  TicketType,
} from '@teamtrack/shared';
import { formatDay } from '../../lib/planning';
import {
  BarList,
  ChartCard,
  Meter,
  NoData,
  SERIES,
  StatGrid,
  WeeklyColumns,
  WeeklyLine,
  type WeekPoint,
} from './charts';

const STATUS_LABEL: Record<StatusCategory, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  testing: 'Testing',
  done: 'Done',
};
const SEVERITY_LABEL: Record<TicketSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};
const TYPE_LABEL: Record<TicketType, string> = {
  bug: 'Bug',
  issue: 'Issue',
  request: 'Request',
  question: 'Question',
  incident: 'Incident',
};
const PERIOD_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' } as const;

const LOAD_SERIES = ['To do', 'In progress', 'Testing'];
const TICKET_SERIES = ['Opened', 'Closed'];

const pct = (v: number | null) => (v === null ? '–' : `${v}%`);
const weekLabel = (start: string) => formatDay(start, { month: 'short', day: 'numeric' });

function GoalRows({ rows }: { rows: [string, ReportGoalPeriodDto][] }) {
  const shown = rows.filter(([, g]) => g.total > 0);
  if (!shown.length) return <NoData>No goals started in this range</NoData>;
  return (
    <ul className="space-y-3">
      {shown.map(([label, g]) => (
        <li key={label} className="text-xs">
          <div className="mb-1 flex justify-between gap-3">
            <span className="text-muted">{label}</span>
            <span className="tabular-nums">
              <span className="font-medium">{g.achieved}</span>
              <span className="text-subtle"> / {g.total} achieved</span>
            </span>
          </div>
          <Meter value={g.completionPct ?? 0} label={`${label} goals achieved`} />
        </li>
      ))}
    </ul>
  );
}

/** The body of the Reports page for one loaded report. */
export function ReportView({ report: r }: { report: TeamReportDto }) {
  const self = r.scope === 'self';
  const throughput: WeekPoint[] = r.weeks.map((w) => ({
    key: w.week,
    label: weekLabel(w.start),
    values: [w.tasksDone],
  }));
  const tickets: WeekPoint[] = r.weeks.map((w) => ({
    key: w.week,
    label: weekLabel(w.start),
    values: [w.ticketsOpened, w.ticketsClosed],
  }));
  const anyTickets = r.tickets.opened + r.tickets.closed > 0;
  const statusRows = (['todo', 'in_progress', 'testing', 'done'] as const).map((c) => ({
    key: c,
    label: STATUS_LABEL[c],
    text: STATUS_LABEL[c],
    values: [r.tasks.byStatus[c]],
  }));
  const loadRows = r.assignees
    .filter((a) => a.open > 0)
    .map((a) => {
      const name = a.user?.name ?? 'Unassigned';
      return {
        key: a.user?.id ?? 'none',
        label: a.user ? name : <span className="text-subtle">Unassigned</span>,
        text: name,
        values: [a.open - a.inProgress - a.testing, a.inProgress, a.testing],
        note: a.overdue ? <span className="text-danger">{a.overdue} overdue</span> : undefined,
      };
    });

  return (
    <div className="space-y-6">
      <StatGrid
        stats={[
          {
            label: self ? 'My open tasks' : 'Open tasks',
            value: r.tasks.open,
            hint: `${r.tasks.created} created in range`,
          },
          {
            label: 'Overdue',
            value: r.tasks.overdue,
            alert: r.tasks.overdue > 0,
            hint: 'open, past due date',
          },
          {
            label: 'Done in range',
            value: r.tasks.completed,
            hint:
              r.tasks.avgLeadTimeDays === null
                ? 'no tasks finished'
                : `avg ${r.tasks.avgLeadTimeDays} days from creation`,
          },
          {
            label: 'First-pass testing',
            value: pct(r.testing.firstPassRate),
            hint: `${r.testing.passedFirstRound} of ${r.testing.passed} passed on round 1`,
          },
          {
            label: 'Tickets opened',
            value: r.tickets.opened,
            hint: `${r.tickets.openNow} open now`,
          },
          { label: 'Tickets closed', value: r.tickets.closed, hint: 'and still closed' },
          {
            label: 'Goals achieved',
            value: pct(r.goals.completionPct),
            hint: `${r.goals.achieved} of ${r.goals.total} goals`,
          },
          { label: 'Goal progress', value: pct(r.goals.avgProgress), hint: 'average across goals' },
        ]}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          className="lg:col-span-2"
          title="Throughput"
          description="Tasks moved to done, per week"
          table={{
            columns: ['Week of', 'Tasks done'],
            rows: r.weeks.map((w) => [weekLabel(w.start), w.tasksDone]),
          }}
        >
          {r.tasks.completed ? (
            <WeeklyLine points={throughput} name="tasks done" height={280} />
          ) : (
            <NoData>No tasks were finished in this range</NoData>
          )}
        </ChartCard>

        <ChartCard
          title="Tickets opened vs closed"
          description="Per week"
          legend={TICKET_SERIES.map((label, i) => ({ label, color: SERIES[i]! }))}
          table={{
            columns: ['Week of', 'Opened', 'Closed'],
            rows: r.weeks.map((w) => [weekLabel(w.start), w.ticketsOpened, w.ticketsClosed]),
          }}
        >
          {anyTickets ? (
            <WeeklyColumns points={tickets} series={TICKET_SERIES} />
          ) : (
            <NoData>No tickets were opened or closed in this range</NoData>
          )}
        </ChartCard>

        <ChartCard
          title="Tasks by status"
          description="Right now, across the selected projects"
          table={{
            columns: ['Status', 'Tasks'],
            rows: statusRows.map((s) => [s.text, s.values[0]!]),
          }}
        >
          {statusRows.some((s) => s.values[0]) ? (
            <BarList rows={statusRows} series={['Tasks']} />
          ) : (
            <NoData>No tasks yet</NoData>
          )}
        </ChartCard>

        <ChartCard
          title={self ? 'My open work' : 'Open work per person'}
          description="Heaviest load first"
          legend={LOAD_SERIES.map((label, i) => ({ label, color: SERIES[i]! }))}
          table={{
            columns: [
              'Person',
              'Open',
              'To do',
              'In progress',
              'Testing',
              'Overdue',
              'Done in range',
            ],
            rows: r.assignees.map((a) => [
              a.user?.name ?? 'Unassigned',
              a.open,
              a.open - a.inProgress - a.testing,
              a.inProgress,
              a.testing,
              a.overdue,
              a.completed,
            ]),
          }}
        >
          {loadRows.length ? (
            <BarList rows={loadRows} series={LOAD_SERIES} />
          ) : (
            <NoData>Nothing open</NoData>
          )}
        </ChartCard>

        <ChartCard
          title="Tickets by severity"
          description="Opened in range; still open in grey text"
          table={{
            columns: ['Severity', 'Opened', 'Still open'],
            rows: r.tickets.bySeverity.map((s) => [SEVERITY_LABEL[s.key], s.opened, s.open]),
          }}
        >
          {r.tickets.opened ? (
            <BarList
              rows={[...r.tickets.bySeverity].reverse().map((s) => ({
                key: s.key,
                label: SEVERITY_LABEL[s.key],
                text: SEVERITY_LABEL[s.key],
                values: [s.opened],
                note: `${s.open} open`,
              }))}
              series={['Opened']}
            />
          ) : (
            <NoData>No tickets opened in this range</NoData>
          )}
        </ChartCard>

        <ChartCard
          title="Tickets by type"
          description="Opened in range; still open in grey text"
          table={{
            columns: ['Type', 'Opened', 'Still open'],
            rows: r.tickets.byType.map((s) => [TYPE_LABEL[s.key], s.opened, s.open]),
          }}
        >
          {r.tickets.opened ? (
            <BarList
              rows={r.tickets.byType
                .filter((s) => s.opened > 0)
                .sort((a, b) => b.opened - a.opened)
                .map((s) => ({
                  key: s.key,
                  label: TYPE_LABEL[s.key],
                  text: TYPE_LABEL[s.key],
                  values: [s.opened],
                  note: `${s.open} open`,
                }))}
              series={['Opened']}
            />
          ) : (
            <NoData>No tickets opened in this range</NoData>
          )}
        </ChartCard>

        <ChartCard
          title="Goal completion"
          description="Goals whose period started in range (cancelled excluded)"
          table={{
            columns: ['Period', 'Goals', 'Achieved', 'Completion', 'Avg progress'],
            rows: (['daily', 'weekly', 'monthly'] as const).map((p) => {
              const g = r.goals.byPeriod[p];
              return [
                PERIOD_LABEL[p],
                g.total,
                g.achieved,
                pct(g.completionPct),
                pct(g.avgProgress),
              ];
            }),
          }}
        >
          <GoalRows
            rows={(['daily', 'weekly', 'monthly'] as const).map((p) => [
              PERIOD_LABEL[p],
              r.goals.byPeriod[p],
            ])}
          />
        </ChartCard>

        <ChartCard
          title="Weekly goals"
          description="Achieved out of set, per week"
          legend={['Achieved', 'Not achieved'].map((label, i) => ({ label, color: SERIES[i]! }))}
          table={{
            columns: ['Week of', 'Goals', 'Achieved'],
            rows: r.weeks.map((w) => [weekLabel(w.start), w.goals, w.goalsAchieved]),
          }}
        >
          {r.weeks.some((w) => w.goals) ? (
            <BarList
              rows={r.weeks
                .filter((w) => w.goals > 0)
                .map((w) => ({
                  key: w.week,
                  label: weekLabel(w.start),
                  text: `Week of ${weekLabel(w.start)}`,
                  values: [w.goalsAchieved, w.goals - w.goalsAchieved],
                  note: `${Math.round((w.goalsAchieved / w.goals) * 100)}%`,
                }))}
              series={['Achieved', 'Not achieved']}
            />
          ) : (
            <NoData>No weekly goals in this range</NoData>
          )}
        </ChartCard>
      </div>
    </div>
  );
}
