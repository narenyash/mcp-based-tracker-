import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, bearer, signup, useTestDb, type TestSession } from './helpers';
import { IdempotencyKey, Task } from '../src/models';

useTestDb();

const base = '/api/v1';

async function project(s: TestSession): Promise<string> {
  const res = await request(app).post(`${base}/projects`).set(bearer(s)).send({ key: 'IDEM', name: 'Idempotency' });
  if (res.status !== 201) throw new Error(`create project failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}
const createTask = (s: TestSession, projectId: string, body: object, key?: string) => {
  const req = request(app).post(`${base}/projects/${projectId}/tasks`).set(bearer(s));
  if (key !== undefined) req.set('Idempotency-Key', key);
  return req.send(body);
};

describe('Idempotency-Key', () => {
  it('creates one task for the same key twice and replays the first response', async () => {
    const owner = await signup();
    const pid = await project(owner);
    const first = await createTask(owner, pid, { title: 'Once' }, 'key-00000001');
    const second = await createTask(owner, pid, { title: 'Once' }, 'key-00000001');
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    expect(await Task.countDocuments({ projectId: first.body.projectId, workspaceId: owner.body.workspace.id })).toBe(1);
  });

  it('handles concurrent duplicates: one create, the rest replay or are told to retry', async () => {
    const owner = await signup();
    const pid = await project(owner);
    const results = await Promise.all(Array.from({ length: 5 }, () => createTask(owner, pid, { title: 'Race' }, 'key-race-0001')));
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(results.filter((r) => r.status === 201 && r.headers['idempotent-replayed'] !== 'true')).toHaveLength(1);
    expect(await Task.countDocuments({ workspaceId: owner.body.workspace.id, title: 'Race' })).toBe(1);
  });

  it('rejects a key reused for a different body', async () => {
    const owner = await signup();
    const pid = await project(owner);
    expect((await createTask(owner, pid, { title: 'A' }, 'key-00000002')).status).toBe(201);
    const reused = await createTask(owner, pid, { title: 'B' }, 'key-00000002');
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('scopes keys per user', async () => {
    const a = await signup();
    const b = await signup({ workspaceName: 'Other' });
    const [pa, pb] = [await project(a), await project(b)];
    const ra = await createTask(a, pa, { title: 'Same' }, 'key-shared-01');
    const rb = await createTask(b, pb, { title: 'Same' }, 'key-shared-01');
    expect(rb.status).toBe(201);
    expect(rb.headers['idempotent-replayed']).toBeUndefined();
    expect(rb.body.id).not.toBe(ra.body.id);
  });

  it('releases the key when the request fails, so a corrected retry can use it', async () => {
    const owner = await signup();
    const pid = await project(owner);
    const bad = await createTask(owner, pid, { title: '' }, 'key-00000003');
    expect(bad.status).toBe(400);
    expect(await IdempotencyKey.countDocuments({})).toBe(0);
    const retry = await createTask(owner, pid, { title: '' }, 'key-00000003');
    expect(retry.status).toBe(400);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
  });

  it('validates the key format and ignores requests without one', async () => {
    const owner = await signup();
    const pid = await project(owner);
    expect((await createTask(owner, pid, { title: 'x' }, 'short')).status).toBe(400);
    expect((await createTask(owner, pid, { title: 'No key' })).status).toBe(201);
    expect((await createTask(owner, pid, { title: 'No key' })).status).toBe(201);
    expect(await IdempotencyKey.countDocuments({})).toBe(0);
  });
});
