import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import type { SessionResponse } from '@teamtrack/shared';
import { createApp } from '../src/app';
import { connectDb, disconnectDb } from '../src/db/connection';
import { runMigrations } from '../src/db/migrator';
import { Outbox } from '../src/models';
import { collectionName } from '../src/config/env';

export const app = createApp();

/** Connects once per file, migrates (validators + indexes), and empties every collection between tests. */
export function useTestDb(): void {
  beforeAll(async () => {
    await connectDb();
    await runMigrations();
  });
  afterEach(async () => {
    const db = mongoose.connection.db!;
    const cols = await db.listCollections({}, { nameOnly: true }).toArray();
    await Promise.all(
      cols.filter((c) => c.name !== collectionName('migrations')).map((c) => db.collection(c.name).deleteMany({})),
    );
  });
  afterAll(async () => {
    await disconnectDb();
  });
}

export interface TestSession {
  agent: ReturnType<typeof request.agent>;
  token: string;
  csrf: string;
  body: SessionResponse;
}

export function cookieValue(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const hit = raw?.find((c) => c.startsWith(`${name}=`));
  return hit?.split(';')[0]?.slice(name.length + 1);
}

function toSession(agent: TestSession['agent'], res: request.Response): TestSession {
  if (res.status >= 300) throw new Error(`auth failed ${res.status}: ${JSON.stringify(res.body)}`);
  const body = res.body as SessionResponse;
  return { agent, token: body.accessToken, csrf: cookieValue(res, 'tt_csrf') ?? '', body };
}

let counter = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}${++counter}@example.com`;
export const PASSWORD = 'correct-horse-battery';

export async function signup(overrides: Partial<{ workspaceName: string; name: string; email: string }> = {}): Promise<TestSession> {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/signup').send({
    workspaceName: overrides.workspaceName ?? 'Acme',
    name: overrides.name ?? 'Owner',
    email: overrides.email ?? uniqueEmail('owner'),
    password: PASSWORD,
  });
  return toSession(agent, res);
}

export async function login(email: string, password = PASSWORD, workspace?: string): Promise<TestSession> {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password, ...(workspace ? { workspace } : {}) });
  return toSession(agent, res);
}

/** Owner invites someone with `role`, then the invitee accepts. Returns the invitee's session. */
export async function inviteAndAccept(owner: TestSession, role: string, email = uniqueEmail(role)): Promise<TestSession> {
  const inv = await owner.agent.post('/api/v1/invites').auth(owner.token, { type: 'bearer' }).send({ email, role });
  if (inv.status !== 201) throw new Error(`invite failed ${inv.status}: ${JSON.stringify(inv.body)}`);
  const msg = await Outbox.findOne({ dedupeKey: `invite:${inv.body.id}` }).lean();
  const url = (msg!.payload as { data: { url: string } }).data.url;
  const token = url.split('/').pop()!;
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/invites/accept').send({ token, name: `${role} person`, password: PASSWORD });
  return toSession(agent, res);
}

export const bearer = (s: TestSession) => ({ Authorization: `Bearer ${s.token}` });
