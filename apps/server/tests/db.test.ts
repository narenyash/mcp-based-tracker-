import { describe, expect, it } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { useTestDb } from './helpers';
import { collectionName } from '../src/config/env';
import { Outbox, Project, User } from '../src/models';
import { withTransaction } from '../src/db/transaction';
import { enqueue } from '../src/services/outbox';
import { processOne } from '../src/workers/outboxWorker';
import { setTransporter } from '../src/services/mailer';

useTestDb();

const job = (to: string) => ({
  template: 'invite' as const,
  to,
  data: { inviterName: 'A', workspaceName: 'W', role: 'member', url: 'http://x/invite/t', expiresInDays: 7 },
});

describe('tenant guard', () => {
  it('throws on a tenant-scoped query without workspaceId', async () => {
    await expect(User.find({ email: 'a@b.c' })).rejects.toThrow(/Tenant guard/);
    await expect(Project.countDocuments({})).rejects.toThrow(/Tenant guard/);
    await expect(Project.aggregate([{ $match: { status: 'active' } }])).rejects.toThrow(/Tenant guard/);
  });

  it('allows explicitly opted-out system queries', async () => {
    await expect(User.find({ email: 'a@b.c' }).setOptions({ skipTenant: true })).resolves.toEqual([]);
  });
});

describe('database validators', () => {
  it('reject invalid documents written around the app (e.g. by a script)', async () => {
    const users = mongoose.connection.db!.collection(collectionName('users'));
    await expect(users.insertOne({ email: 'x@y.z', name: 'X', role: 'superuser', status: 'active', workspaceId: new Types.ObjectId() })).rejects.toThrow(/validation/i);
  });

  it('created every declared index', async () => {
    const indexes = await mongoose.connection.db!.collection(collectionName('projects')).indexes();
    expect(indexes.some((i) => i.key.workspaceId === 1 && i.key.key === 1 && i.unique)).toBe(true);
  });
});

describe('transactional outbox', () => {
  it('records nothing if the transaction aborts', async () => {
    await expect(
      withTransaction(async (session) => {
        await enqueue(session, [{ type: 'email.send', dedupeKey: 'abort-1', payload: job('a@example.com') }]);
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');
    expect(await Outbox.countDocuments({})).toBe(0);
  });

  it('dedupes on dedupeKey', async () => {
    for (let i = 0; i < 3; i++) {
      await withTransaction((session) => enqueue(session, [{ type: 'email.send', dedupeKey: 'same', payload: job('b@example.com') }]));
    }
    expect(await Outbox.countDocuments({})).toBe(1);
  });

  it('retries with backoff on failure, then succeeds', async () => {
    await withTransaction((session) => enqueue(session, [{ type: 'email.send', dedupeKey: 'retry', payload: job('c@example.com') }]));
    setTransporter({ sendMail: () => Promise.reject(new Error('SMTP down')) } as never);
    try {
      await processOne();
    } finally {
      setTransporter(undefined);
    }
    const failed = await Outbox.findOne({ dedupeKey: 'retry' }).lean();
    expect(failed?.status).toBe('pending');
    expect(failed?.attempts).toBe(1);
    expect(failed?.lastError).toBe('SMTP down');
    expect(failed!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // Not due yet: nothing to do.
    expect(await processOne()).toBe(false);
    await Outbox.updateOne({ dedupeKey: 'retry' }, { $set: { nextAttemptAt: new Date() } });
    expect(await processOne()).toBe(true);
    expect((await Outbox.findOne({ dedupeKey: 'retry' }).lean())?.status).toBe('done');
  });
});

describe('shared-database safety', () => {
  it('stores every collection under the tt_ prefix', async () => {
    const names = (await mongoose.connection.db!.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter((n) => !n.startsWith('tt_'))).toEqual([]);
  });
});
