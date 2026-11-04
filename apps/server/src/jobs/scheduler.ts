import { setTimeout as sleep } from 'node:timers/promises';
import { JobLock } from '../models/JobLock';
import { logger } from '../observability/logger';
import { errorText } from '../workers/errorText';

export interface Job {
  name: string;
  everyMs: number;
  /** Upper bound on one run; the lease expires after this so a crashed instance can't block the job forever. */
  leaseMs: number;
  /** Aborted when the run outlives its lease; long jobs should check it between batches. */
  run(signal: AbortSignal): Promise<void>;
}

const TICK_MS = 15_000;
const isDuplicateKey = (err: unknown) => (err as { code?: number }).code === 11000;

/**
 * Takes the job's lease if it is due and nobody holds it. Safe across instances: the filter and the
 * update are one atomic findOneAndUpdate, and a racing first-time upsert loses on the unique _id.
 */
async function acquire(job: Job, now: Date): Promise<Date | null> {
  const lease = new Date(now.getTime() + job.leaseMs);
  try {
    const doc = await JobLock.findOneAndUpdate(
      { _id: job.name, nextRunAt: { $lte: now }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
      { $set: { lockedUntil: lease }, $setOnInsert: { nextRunAt: now } },
      { upsert: true, new: true },
    ).lean();
    return doc ? lease : null;
  } catch (err) {
    if (isDuplicateKey(err)) return null;
    throw err;
  }
}

class LeaseExpiredError extends Error {
  constructor(job: Job) {
    super(`run exceeded its ${job.leaseMs} ms lease`);
  }
}

/** Runs the job, giving up (and aborting its signal) once the lease is over. */
async function runWithinLease(job: Job): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new LeaseExpiredError(job);
      controller.abort(err);
      reject(err);
    }, job.leaseMs);
  });
  try {
    await Promise.race([job.run(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runJobOnce(job: Job, now = new Date()): Promise<boolean> {
  const lease = await acquire(job, now);
  if (!lease) return false;
  let lastError: string | null = null;
  const started = Date.now();
  try {
    await runWithinLease(job);
  } catch (err) {
    lastError = errorText(err);
    if (err instanceof LeaseExpiredError) logger.error({ job: job.name, leaseMs: job.leaseMs }, 'scheduled job timed out, lease released');
    else logger.error({ err, job: job.name }, 'scheduled job failed');
  }
  // Only release our own lease: after a timeout another instance may already hold a newer one.
  await JobLock.updateOne(
    { _id: job.name, lockedUntil: lease },
    { $set: { lockedUntil: null, lastRunAt: new Date(), lastError, nextRunAt: new Date(Date.now() + job.everyMs) } },
  );
  logger.debug({ job: job.name, ms: Date.now() - started }, 'scheduled job finished');
  return true;
}

/** Runs each job on its interval on whichever instance gets the lease. `stop()` waits for a running job. */
export function startScheduler(jobs: Job[]): { stop: () => Promise<void> } {
  const controller = new AbortController();
  const loop = (async () => {
    while (!controller.signal.aborted) {
      for (const job of jobs) {
        if (controller.signal.aborted) break;
        try {
          await runJobOnce(job);
        } catch (err) {
          logger.error({ err, job: job.name }, 'scheduler tick failed');
        }
      }
      await sleep(TICK_MS, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  })();
  logger.info({ jobs: jobs.map((j) => j.name) }, 'scheduler started');
  return {
    async stop() {
      controller.abort();
      await loop;
    },
  };
}
