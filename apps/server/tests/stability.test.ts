import { describe, expect, it } from 'vitest';
import { useTestDb } from './helpers';
import { validateEnv } from '../src/config/env';
import { JobLock, Outbox } from '../src/models';
import { withTransaction } from '../src/db/transaction';
import { enqueue } from '../src/services/outbox';
import { setTransporter } from '../src/services/mailer';
import { processOne } from '../src/workers/outboxWorker';
import { errorText } from '../src/workers/errorText';
import { runJobOnce } from '../src/jobs/scheduler';

useTestDb();

const SECRET = 'prod-secret-prod-secret-prod-secret-0123456789';
const prodEnv = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  MONGO_URI: 'mongodb://localhost:27017/x',
  JWT_ACCESS_SECRET: SECRET,
  CLIENT_URL: 'https://teamtrack.example.com',
  TRUST_PROXY: '1',
  STORAGE_DRIVER: 's3',
  AWS_BUCKET_NAME: 'bucket',
  MAIL_TRANSPORT: 'json',
  ...overrides,
});
const issues = (source: NodeJS.ProcessEnv) => validateEnv(source).issues.join('\n');

describe('production config guards', () => {
  it('accepts a complete production config', () => {
    expect(validateEnv(prodEnv()).issues).toEqual([]);
  });

  it('requires CLIENT_URL and TRUST_PROXY to be set explicitly', () => {
    expect(issues(prodEnv({ CLIENT_URL: undefined }))).toMatch(/CLIENT_URL: required in production/);
    expect(issues(prodEnv({ TRUST_PROXY: undefined }))).toMatch(/TRUST_PROXY: set it explicitly/);
    expect(validateEnv(prodEnv({ TRUST_PROXY: '0' })).issues).toEqual([]);
  });

  it('refuses memory storage unless explicitly allowed', () => {
    expect(issues(prodEnv({ STORAGE_DRIVER: 'memory' }))).toMatch(/STORAGE_DRIVER: memory storage/);
    expect(issues(prodEnv({ STORAGE_DRIVER: undefined, AWS_BUCKET_NAME: undefined }))).toMatch(/STORAGE_DRIVER/);
    expect(validateEnv(prodEnv({ STORAGE_DRIVER: 'memory', ALLOW_MEMORY_STORAGE: 'true' })).issues).toEqual([]);
  });

  it('refuses MAIL_REDIRECT_TO and short rotated-out JWT secrets', () => {
    expect(issues(prodEnv({ MAIL_REDIRECT_TO: 'me@example.com' }))).toMatch(/MAIL_REDIRECT_TO/);
    expect(issues(prodEnv({ JWT_PREVIOUS_KEYS: 'old:short' }))).toMatch(/kid old must be at least 32/);
    expect(issues(prodEnv({ JWT_PREVIOUS_KEYS: 'no-kid' }))).toMatch(/kid:secret pairs/);
    expect(validateEnv(prodEnv({ JWT_PREVIOUS_KEYS: `old:${SECRET}` })).issues).toEqual([]);
  });

  it('leaves development and test configs alone', () => {
    const dev = { MONGO_URI: 'mongodb://localhost:27017/x', JWT_ACCESS_SECRET: SECRET };
    expect(validateEnv({ ...dev, NODE_ENV: 'development' }).issues).toEqual([]);
    expect(validateEnv({ ...dev, NODE_ENV: 'test', MAIL_REDIRECT_TO: 'me@example.com' }).issues).toEqual([]);
  });
});

describe('outbox worker', () => {
  it('turns any thrown value into a message', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('plain')).toBe('plain');
    expect(errorText({ code: 42 })).toBe('{"code":42}');
    expect(errorText(undefined)).toBe('undefined');
    expect(errorText('x'.repeat(5000))).toHaveLength(2000);
  });

  it('releases a message whose handler throws a non-Error', async () => {
    const payload = { template: 'invite' as const, to: 'n@example.com', data: { inviterName: 'A', workspaceName: 'W', role: 'member', url: 'http://x/invite/t', expiresInDays: 7 } };
    await withTransaction((session) => enqueue(session, [{ type: 'email.send', dedupeKey: 'non-error', payload }]));
    setTransporter({ sendMail: () => Promise.reject({ code: 'ESOCKET' }) } as never);
    try {
      expect(await processOne()).toBe(true);
    } finally {
      setTransporter(undefined);
    }
    const msg = await Outbox.findOne({ dedupeKey: 'non-error' }).lean();
    expect(msg?.status).toBe('pending');
    expect(msg?.lockedUntil).toBeNull();
    expect(msg?.lastError).toContain('ESOCKET');
  });
});

describe('scheduler', () => {
  it('gives up on a run that outlives its lease, aborts it, and releases the lock', async () => {
    let signal: AbortSignal | undefined;
    const job = { name: 'stuck-job', everyMs: 60_000, leaseMs: 100, run: (s: AbortSignal) => ((signal = s), new Promise<void>(() => undefined)) };
    expect(await runJobOnce(job)).toBe(true);
    expect(signal?.aborted).toBe(true);
    const lock = await JobLock.findById('stuck-job').lean();
    expect(lock?.lockedUntil).toBeNull();
    expect(lock?.lastError).toMatch(/exceeded its 100 ms lease/);
    expect(lock!.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });
});
