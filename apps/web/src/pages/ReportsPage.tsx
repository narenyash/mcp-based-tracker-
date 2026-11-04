import { useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { REPORT_MAX_DAYS } from '@teamtrack/shared';
import { projectsApi } from '../api/endpoints';
import { reportKeys, reportsApi, type TeamReportParams } from '../api/reports';
import { errorMessage, problemOf } from '../lib/errors';
import { addDays, fromKey, todayKey } from '../lib/planning';
import { ErrorNote, Input, PageHeader, Select, Spinner } from '../components/ui';
import { VizStyle } from '../components/reports/charts';
import { ReportView } from '../components/reports/ReportView';

/** Range presets, in weeks (the current week plus the ones before it). */
const PRESETS = [
  { value: '4', label: 'Last 4 weeks' },
  { value: '8', label: 'Last 8 weeks' },
  { value: '13', label: 'Last quarter' },
  { value: '26', label: 'Last 6 months' },
  { value: '52', label: 'Last 12 months' },
] as const;
const DEFAULT_PRESET = '8';

const isDateKey = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Monday of the week `weeks - 1` weeks before this one (local calendar). */
function presetFrom(weeks: number): string {
  const today = todayKey();
  const monday = addDays(today, -((fromKey(today).getDay() + 6) % 7));
  return addDays(monday, -7 * (weeks - 1));
}

/** Phase 9: team (or, for members, personal) stats over a date range. */
export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? '';
  const customFrom = params.get('from');
  const customTo = params.get('to');
  const custom = isDateKey(customFrom) || isDateKey(customTo);
  const preset = PRESETS.find((p) => p.value === params.get('range'))?.value ?? DEFAULT_PRESET;

  const query: TeamReportParams = custom
    ? {
        projectId,
        from: isDateKey(customFrom) ? customFrom : undefined,
        to: isDateKey(customTo) ? customTo : undefined,
      }
    : { projectId, from: presetFrom(Number(preset)) };

  const projects = useQuery({
    queryKey: ['projects', 'active'],
    queryFn: () => projectsApi.list({ status: 'active' }),
  });
  const report = useQuery({
    queryKey: reportKeys.team(query),
    queryFn: () => reportsApi.team(query),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: (n, err) => problemOf(err)?.status !== 400 && n < 2,
  });

  const update = (changes: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(changes)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );

  const r = report.data;
  const fieldError = problemOf(report.error)?.errors?.[0]?.message;

  return (
    <>
      <VizStyle />
      <PageHeader
        title="Reports"
        description={
          r?.scope === 'self'
            ? 'Your own work: what you have open, finished and tested.'
            : 'How work is flowing: load, throughput, tickets, goals and testing.'
        }
      />

      <form
        className="mb-8 flex flex-wrap items-end gap-3"
        aria-label="Report filters"
        onSubmit={(e) => e.preventDefault()}
      >
        <label className="space-y-1.5">
          <span className="block text-xs font-medium text-muted">Project</span>
          <Select
            className="w-48"
            value={projectId}
            onChange={(e) => update({ project: e.target.value || null })}
          >
            <option value="">All projects</option>
            {projects.data?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="space-y-1.5">
          <span className="block text-xs font-medium text-muted">Range</span>
          <Select
            className="w-44"
            value={custom ? 'custom' : preset}
            onChange={(e) =>
              e.target.value === 'custom'
                ? update({
                    range: null,
                    from: r?.range.from ?? presetFrom(Number(preset)),
                    to: r?.range.to ?? todayKey(),
                  })
                : update({
                    range: e.target.value === DEFAULT_PRESET ? null : e.target.value,
                    from: null,
                    to: null,
                  })
            }
          >
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </Select>
        </label>
        {custom && (
          <>
            <label className="space-y-1.5">
              <span className="block text-xs font-medium text-muted">From</span>
              <Input
                type="date"
                className="w-40"
                value={customFrom ?? ''}
                max={customTo ?? undefined}
                onChange={(e) => update({ from: e.target.value || null })}
              />
            </label>
            <label className="space-y-1.5">
              <span className="block text-xs font-medium text-muted">To</span>
              <Input
                type="date"
                className="w-40"
                value={customTo ?? ''}
                min={customFrom ?? undefined}
                onChange={(e) => update({ to: e.target.value || null })}
              />
            </label>
          </>
        )}
        <span className="pb-2 text-xs text-subtle" aria-live="polite">
          {report.isFetching ? (
            <Spinner className="size-3.5" />
          ) : r ? (
            `${r.range.from} – ${r.range.to} · ${r.range.timezone}`
          ) : null}
        </span>
      </form>

      {report.isError && (
        <div className="mb-6">
          <ErrorNote>
            {fieldError
              ? `${fieldError}. Ranges can span up to ${REPORT_MAX_DAYS} days.`
              : errorMessage(report.error)}
          </ErrorNote>
        </div>
      )}
      {report.isPending ? <Spinner /> : r ? <ReportView report={r} /> : null}
    </>
  );
}
