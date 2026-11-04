import { createHash, timingSafeEqual } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Request, RequestHandler } from 'express';
import { env } from '../config/env';
import { UnauthorizedError } from '../errors/AppError';
import { Outbox } from '../models/Outbox';
import { logger } from './logger';

/*
 * Dependency-free Prometheus text exposition (format 0.0.4) for one process.
 *  - http_requests_total / http_request_duration_seconds, labelled by the matched route *pattern*
 *    (`/api/v1/tasks/:id`, never the raw URL), so label cardinality stays bounded.
 *  - Outbox backlog (pending / processing / dead) and delivery lag, read from Mongo at scrape time.
 *  - A few process gauges (RSS, heap, event-loop delay).
 * Mounted only when METRICS_TOKEN is set; scrape it from inside the network (nginx does not proxy it).
 */

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const UNMATCHED = '(unmatched)';
/** Status for requests the client abandoned before the response finished (nginx's convention). */
const CLIENT_CLOSED = 499;

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}

const requestCounts = new Map<string, number>();
const durations = new Map<string, Histogram>();
const startedAt = Date.now();
const loopDelay = monitorEventLoopDelay({ resolution: 20 });

function record(method: string, route: string, status: number, seconds: number): void {
  const countKey = `${method}\u0000${route}\u0000${status}`;
  requestCounts.set(countKey, (requestCounts.get(countKey) ?? 0) + 1);

  const durKey = `${method}\u0000${route}`;
  let h = durations.get(durKey);
  if (!h) {
    h = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    durations.set(durKey, h);
  }
  // Buckets are stored non-cumulative and summed at render time.
  const idx = BUCKETS.findIndex((b) => seconds <= b);
  if (idx >= 0) h.buckets[idx]! += 1;
  h.sum += seconds;
  h.count += 1;
}

/**
 * Captures the full route pattern at the moment the router matches it. Express sets `req.route` with
 * `req.baseUrl` still pointing at the matching router; by the time the response finishes (or an error
 * has bubbled out to the app-level handler) baseUrl has been unwound, so reading it later is unreliable.
 */
function trackRoute(req: Request): () => string {
  let matched: string | undefined;
  let route: unknown;
  Object.defineProperty(req, 'route', {
    configurable: true,
    enumerable: true,
    get: () => route,
    set(value: { path?: unknown } | undefined) {
      route = value;
      if (value && typeof value.path === 'string') matched = req.baseUrl + value.path;
    },
  });
  return () => matched ?? UNMATCHED;
}

export const metricsMiddleware: RequestHandler = (req, res, next) => {
  const start = process.hrtime.bigint();
  const routeOf = trackRoute(req);
  const method = METHODS.has(req.method) ? req.method : 'OTHER';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    record(method, routeOf(), res.writableFinished ? res.statusCode : CLIENT_CLOSED, seconds);
  };
  res.once('finish', finish);
  res.once('close', finish);
  next();
};

/* ---- exposition */

const escapeLabel = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labels = (pairs: Record<string, string | number>) =>
  `{${Object.entries(pairs)
    .map(([k, v]) => `${k}="${escapeLabel(String(v))}"`)
    .join(',')}}`;

function header(lines: string[], name: string, type: 'counter' | 'gauge' | 'histogram', help: string): void {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
}

function renderHttp(lines: string[]): void {
  header(lines, 'http_requests_total', 'counter', 'Completed HTTP requests by route pattern and status.');
  for (const [key, value] of requestCounts) {
    const [method = '', route = '', status = ''] = key.split('\u0000');
    lines.push(`http_requests_total${labels({ method, route, status })} ${value}`);
  }

  header(lines, 'http_request_duration_seconds', 'histogram', 'HTTP request latency by route pattern.');
  for (const [key, h] of durations) {
    const [method = '', route = ''] = key.split('\u0000');
    let cumulative = 0;
    BUCKETS.forEach((le, i) => {
      cumulative += h.buckets[i]!;
      lines.push(`http_request_duration_seconds_bucket${labels({ method, route, le })} ${cumulative}`);
    });
    lines.push(`http_request_duration_seconds_bucket${labels({ method, route, le: '+Inf' })} ${h.count}`);
    lines.push(`http_request_duration_seconds_sum${labels({ method, route })} ${h.sum}`);
    lines.push(`http_request_duration_seconds_count${labels({ method, route })} ${h.count}`);
  }
}

async function renderOutbox(lines: string[]): Promise<void> {
  try {
    const now = new Date();
    const [pending, processing, dead, oldestDue] = await Promise.all([
      Outbox.countDocuments({ status: 'pending' }),
      Outbox.countDocuments({ status: 'processing' }),
      Outbox.countDocuments({ status: 'dead' }),
      Outbox.findOne({ status: 'pending', nextAttemptAt: { $lte: now } }, { nextAttemptAt: 1 })
        .sort({ nextAttemptAt: 1 })
        .lean(),
    ]);
    header(lines, 'teamtrack_outbox_messages', 'gauge', 'Outbox messages by status (done is omitted).');
    lines.push(`teamtrack_outbox_messages${labels({ status: 'pending' })} ${pending}`);
    lines.push(`teamtrack_outbox_messages${labels({ status: 'processing' })} ${processing}`);
    lines.push(`teamtrack_outbox_messages${labels({ status: 'dead' })} ${dead}`);
    header(lines, 'teamtrack_outbox_lag_seconds', 'gauge', 'Age of the oldest message that is due but not yet delivered.');
    const lag = oldestDue ? Math.max(0, (now.getTime() - oldestDue.nextAttemptAt.getTime()) / 1000) : 0;
    lines.push(`teamtrack_outbox_lag_seconds ${lag}`);
  } catch (err) {
    // A metrics scrape must never fail because Mongo is unhealthy; /readyz reports that.
    logger.warn({ err: (err as Error).message }, 'metrics: outbox query failed');
    header(lines, 'teamtrack_outbox_scrape_error', 'gauge', '1 when the outbox could not be read during this scrape.');
    lines.push('teamtrack_outbox_scrape_error 1');
  }
}

function renderProcess(lines: string[]): void {
  const mem = process.memoryUsage();
  header(lines, 'process_resident_memory_bytes', 'gauge', 'Resident set size.');
  lines.push(`process_resident_memory_bytes ${mem.rss}`);
  header(lines, 'nodejs_heap_used_bytes', 'gauge', 'V8 heap in use.');
  lines.push(`nodejs_heap_used_bytes ${mem.heapUsed}`);
  header(lines, 'process_start_time_seconds', 'gauge', 'Process start time, unix seconds.');
  lines.push(`process_start_time_seconds ${Math.floor(startedAt / 1000)}`);
  header(lines, 'nodejs_eventloop_delay_p99_seconds', 'gauge', 'p99 event-loop delay since the previous scrape.');
  lines.push(`nodejs_eventloop_delay_p99_seconds ${loopDelay.percentile(99) / 1e9}`);
  loopDelay.reset();
}

const digest = (v: string) => createHash('sha256').update(v).digest();

/** Constant-time Bearer check (hashing first, so the token length isn't leaked either). */
function authorized(header: string | undefined): boolean {
  if (!env.METRICS_TOKEN || !header?.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(header.slice(7)), digest(env.METRICS_TOKEN));
}

export const metricsHandler: RequestHandler = async (req, res) => {
  if (!authorized(req.get('authorization'))) throw new UnauthorizedError();
  const lines: string[] = [];
  renderHttp(lines);
  await renderOutbox(lines);
  renderProcess(lines);
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/plain; version=0.0.4; charset=utf-8').send(`${lines.join('\n')}\n`);
};

/** Starts the event-loop sampler. Called once when metrics are enabled, so disabled servers pay nothing. */
export function enableMetrics(): void {
  loopDelay.enable();
}
