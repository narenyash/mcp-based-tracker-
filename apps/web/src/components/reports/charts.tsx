import type { ReactNode } from 'react';
import { cx } from '../ui';

/*
 * Minimal charts in plain HTML/CSS/SVG (no chart library). Conventions:
 * - Series colours: the ink accent leads, the other series are graphite steps, defined once in
 *   <VizStyle/>. A single-series bar list stays neutral. Text never wears a series colour.
 * - Every chart is a <figure> with a caption and a "Show table" fallback; identity is never colour
 *   alone (legend + labels); each mark carries a native tooltip with its exact value.
 */

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'] as const;

/** Chart colour tokens. The app's dark mode follows the OS, so these do too. */
export function VizStyle() {
  return (
    <style>{`
      .tt-viz { --series-1: var(--color-ink); --series-2: #8b8882; --series-3: #c9c7c1; }
      @media (prefers-color-scheme: dark) {
        .tt-viz { --series-2: #75736e; --series-3: #474643; }
      }
    `}</style>
  );
}

const fmt = (n: number) => n.toLocaleString();

/** Axis max rounded up so that it and its half are whole, distinct numbers (2, 4, 6, 10, 20, 50 ...). */
export function niceMax(m: number): number {
  if (m <= 2) return 2;
  const p = 10 ** Math.floor(Math.log10(m));
  for (const f of [1, 2, 4, 5, 6, 8, 10]) {
    const v = f * p;
    if (v >= m && Number.isInteger(v / 2)) return v;
  }
  return 10 * p;
}

/* ----------------------------------------------------------------- tiles */

export interface Stat {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** Draws attention (e.g. overdue > 0). */
  alert?: boolean;
}

export function StatGrid({ stats, className }: { stats: Stat[]; className?: string }) {
  return (
    <dl
      className={cx(
        'grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4',
        className,
      )}
    >
      {stats.map((s) => (
        <div key={s.label} className="bg-bg p-4">
          <dt className="text-xs text-muted">{s.label}</dt>
          <dd className={cx('mt-2 text-2xl leading-none font-medium tabular-nums', s.alert && 'text-danger')}>
            {s.value}
          </dd>
          {s.hint && <dd className="mt-0.5 text-xs text-subtle">{s.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

/* ---------------------------------------------------------------- frame */

export interface TableSpec {
  columns: string[];
  rows: (string | number)[][];
}

/** Figure + caption + optional legend + collapsible data table. */
export function ChartCard({
  title,
  description,
  legend,
  table,
  children,
  className,
}: {
  title: string;
  description?: string;
  legend?: { label: string; color: string }[];
  table?: TableSpec;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={cx('tt-viz min-w-0 rounded-lg border border-border p-5', className)}>
      <figcaption className="mb-4">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        {legend && legend.length > 1 && (
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1" aria-label="Legend">
            {legend.map((l) => (
              <li key={l.label} className="flex items-center gap-1.5 text-xs text-muted">
                <span aria-hidden className="size-2.5 rounded-sm" style={{ background: l.color }} />
                {l.label}
              </li>
            ))}
          </ul>
        )}
      </figcaption>
      {children}
      {table && table.rows.length > 0 && (
        <details className="mt-4 text-xs">
          <summary className="cursor-pointer text-muted select-none hover:text-fg">
            Show table
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left tabular-nums">
              <caption className="sr-only">{title}</caption>
              <thead>
                <tr className="border-b border-border text-muted">
                  {table.columns.map((c, i) => (
                    <th
                      key={c}
                      scope="col"
                      className={cx('py-1.5 pr-3 font-medium', i > 0 && 'text-right')}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, ri) => (
                  <tr key={ri} className="border-b border-border last:border-0">
                    {r.map((cell, ci) =>
                      ci === 0 ? (
                        <th key={ci} scope="row" className="py-1.5 pr-3 font-normal">
                          {cell}
                        </th>
                      ) : (
                        <td key={ci} className="py-1.5 pr-3 text-right">
                          {typeof cell === 'number' ? fmt(cell) : cell}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}

export function NoData({ children = 'Nothing in this range' }: { children?: ReactNode }) {
  return <p className="py-6 text-center text-xs text-subtle">{children}</p>;
}

/* ------------------------------------------------------ horizontal bars */

export interface BarRow {
  key: string;
  label: ReactNode;
  /** Plain-text label for tooltips. */
  text: string;
  /** One value per series, in series order. */
  values: number[];
  /** Muted text after the total (e.g. "2 overdue"). */
  note?: ReactNode;
}

/**
 * Horizontal bars, one row per item, stacked when there is more than one series. Bars share one
 * scale (the largest row total); the total is printed at the end of each row.
 */
export function BarList({ rows, series }: { rows: BarRow[]; series: string[] }) {
  const max = Math.max(1, ...rows.map((r) => r.values.reduce((a, b) => a + b, 0)));
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => {
        const total = r.values.reduce((a, b) => a + b, 0);
        const parts = r.values.map((v, i) => `${series[i]}: ${fmt(v)}`).join(', ');
        return (
          <li
            key={r.key}
            className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-xs"
          >
            <span className="truncate text-muted" title={r.text}>
              {r.label}
            </span>
            <span
              className="flex h-3 min-w-0 gap-0.5"
              role="img"
              aria-label={`${r.text}: ${series.length > 1 ? parts : fmt(total)}`}
            >
              {r.values.map((v, i) =>
                v > 0 ? (
                  <span
                    key={i}
                    title={`${r.text} · ${series[i]}: ${fmt(v)}`}
                    className="h-full transition-opacity first:rounded-l-sm last:rounded-r-sm hover:opacity-80"
                    style={{ width: `${(v / max) * 100}%`, background: series.length > 1 ? SERIES[i % SERIES.length] : SERIES[1] }}
                  />
                ) : null,
              )}
            </span>
            <span className="text-right tabular-nums">
              <span className="font-medium">{fmt(total)}</span>
              {r.note && <span className="ml-1.5 text-subtle">{r.note}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------------------------------------------------- weekly columns */

export interface WeekPoint {
  /** e.g. "2026-W45" */
  key: string;
  /** Short axis label, e.g. "Nov 2". */
  label: string;
  values: number[];
}

/** Every nth axis label, so up to ~a year of weeks stays legible. */
const labelEvery = (n: number) => (n <= 10 ? 1 : n <= 20 ? 2 : n <= 36 ? 4 : 8);

function YScale({ max }: { max: number }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {[1, 0.5].map((f) => (
        <div
          key={f}
          className="absolute inset-x-0 border-t border-dashed border-border"
          style={{ bottom: `${f * 100}%` }}
        >
          <span className="absolute -top-2 left-0 bg-bg pr-1 text-2xs leading-none text-subtle tabular-nums">
            {fmt(max * f)}
          </span>
        </div>
      ))}
    </div>
  );
}

function XLabels({ points }: { points: WeekPoint[] }) {
  const every = labelEvery(points.length);
  return (
    <div aria-hidden className="mt-1.5 flex gap-1 text-2xs text-subtle">
      {points.map((p, i) => (
        <span key={p.key} className="min-w-0 flex-1 truncate text-center">
          {i % every === 0 ? p.label : ''}
        </span>
      ))}
    </div>
  );
}

/** Grouped vertical columns per week (one column per series). */
export function WeeklyColumns({
  points,
  series,
  height = 160,
}: {
  points: WeekPoint[];
  series: string[];
  height?: number;
}) {
  const max = niceMax(Math.max(1, ...points.flatMap((p) => p.values)));
  return (
    <div>
      <div className="relative ml-6" style={{ height }}>
        <YScale max={max} />
        <div className="absolute inset-0 flex items-end gap-1 border-b border-border">
          {points.map((p) => (
            <div
              key={p.key}
              role="img"
              aria-label={`Week of ${p.label}: ${p.values.map((v, i) => `${series[i]} ${v}`).join(', ')}`}
              className="flex h-full min-w-0 flex-1 items-end justify-center gap-0.5 hover:bg-hover"
              title={`Week of ${p.label}\n${p.values.map((v, i) => `${series[i]}: ${fmt(v)}`).join('\n')}`}
            >
              {p.values.map((v, i) => (
                <span
                  key={i}
                  className="w-full max-w-4 rounded-t-sm"
                  style={{
                    height: v ? `max(2px, ${(v / max) * 100}%)` : 0,
                    background: SERIES[i % SERIES.length],
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="ml-6">
        <XLabels points={points} />
      </div>
    </div>
  );
}

/** One series over weeks: a 2px line with a dot per week. */
export function WeeklyLine({
  points,
  name,
  height = 160,
}: {
  points: WeekPoint[];
  name: string;
  height?: number;
}) {
  const values = points.map((p) => p.values[0] ?? 0);
  const max = niceMax(Math.max(1, ...values));
  const n = points.length;
  // Each week sits at the centre of its slot, matching the column chart's spacing.
  const x = (i: number) => ((i + 0.5) / n) * 100;
  const y = (v: number) => 100 - (v / max) * 100;
  const path = values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(' ');
  const area = `${path} L${x(n - 1)},100 L${x(0)},100 Z`;
  return (
    <div>
      <div className="relative ml-6" style={{ height }}>
        <YScale max={max} />
        <div className="absolute inset-0 border-b border-border">
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 size-full overflow-visible"
            aria-hidden
          >
            <path d={area} fill={SERIES[0]} fillOpacity={0.08} stroke="none" />
            <path
              d={path}
              fill="none"
              stroke={SERIES[0]}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
          {points.map((p, i) => (
            // A wide, full-height hit target per week; the dot is the visible mark.
            <div
              key={p.key}
              role="img"
              aria-label={`Week of ${p.label}: ${values[i]} ${name}`}
              title={`Week of ${p.label}\n${name}: ${fmt(values[i]!)}`}
              className="group absolute inset-y-0 -translate-x-1/2"
              style={{ left: `${x(i)}%`, width: `${100 / n}%` }}
            >
              <span
                className="absolute left-1/2 size-2 -translate-x-1/2 translate-y-1/2 rounded-full ring-2 ring-bg transition-shadow group-hover:ring-4"
                style={{ bottom: `${100 - y(values[i]!)}%`, background: SERIES[0] }}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="ml-6">
        <XLabels points={points} />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- progress */

/** Thin progress meter (0..100) with an accessible value. */
export function Meter({
  value,
  label,
  className,
}: {
  value: number;
  label: string;
  className?: string;
}) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v}
      aria-valuetext={`${v}%`}
      className={cx('tt-viz h-1.5 overflow-hidden rounded-full bg-hover', className)}
    >
      <div className="h-full rounded-full" style={{ width: `${v}%`, background: SERIES[0] }} />
    </div>
  );
}
