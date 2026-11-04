import { setTimeout as sleep } from 'node:timers/promises';
import { Outbox, type IOutbox, type OutboxType } from '../models/Outbox';
import { sendEmail, type EmailJob } from '../services/mailer';
import { deliverNotification, type NotifyJob } from '../services/notifier';
import { logger } from '../observability/logger';
import { errorText } from './errorText';

const LOCK_MS = 60_000;
const IDLE_POLL_MS = 1_000;
/** Delay before attempt n+1 (index = attempts already made - 1). */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 12 * 3600_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

const handlers: Record<OutboxType, (msg: IOutbox) => Promise<void>> = {
  'email.send': (msg) => sendEmail(msg.payload as unknown as EmailJob, msg._id),
  notify: (msg) => deliverNotification(msg.payload as unknown as NotifyJob, msg.dedupeKey),
};

/** Claims one due message. Expired locks (crashed worker) are reclaimed. Safe with many workers. */
async function claimNext(): Promise<IOutbox | null> {
  const now = new Date();
  return Outbox.findOneAndUpdate(
    {
      $or: [
        { status: 'pending', nextAttemptAt: { $lte: now } },
        { status: 'processing', lockedUntil: { $lt: now } },
      ],
    },
    { $set: { status: 'processing', lockedUntil: new Date(now.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
    { sort: { nextAttemptAt: 1 }, new: true },
  ).lean<IOutbox>();
}

export async function processOne(): Promise<boolean> {
  const msg = await claimNext();
  if (!msg) return false;
  try {
    await handlers[msg.type](msg);
    await Outbox.updateOne(
      { _id: msg._id },
      { $set: { status: 'done', processedAt: new Date(), lockedUntil: null, lastError: null } },
    );
  } catch (err) {
    const error = errorText(err);
    const dead = msg.attempts >= MAX_ATTEMPTS;
    const delay = BACKOFF_MS[Math.min(msg.attempts - 1, BACKOFF_MS.length - 1)]!;
    await Outbox.updateOne(
      { _id: msg._id },
      {
        $set: {
          status: dead ? 'dead' : 'pending',
          lastError: error,
          lockedUntil: null,
          nextAttemptAt: new Date(Date.now() + delay),
        },
      },
    );
    const log = { outboxId: msg._id.toHexString(), type: msg.type, attempts: msg.attempts, error };
    if (dead) logger.error(log, 'outbox message dead-lettered');
    else logger.warn(log, 'outbox message failed, will retry');
  }
  return true;
}

/** Drains due messages, then polls. `stop()` waits for the in-flight message to finish. */
export function startOutboxWorker(): { stop: () => Promise<void> } {
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const didWork = await processOne();
        if (!didWork) await sleep(IDLE_POLL_MS);
      } catch (err) {
        logger.error({ err }, 'outbox worker loop error');
        await sleep(IDLE_POLL_MS * 5);
      }
    }
  })();
  logger.info('outbox worker started');
  return {
    async stop() {
      running = false;
      await loop;
    },
  };
}
