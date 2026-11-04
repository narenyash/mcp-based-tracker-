import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { SNAKE_MAX_SCORE } from '@teamtrack/shared';
import { app, bearer, signup, useTestDb, type TestSession } from './helpers';

useTestDb();

const base = '/api/v1';
const submit = (s: TestSession, score: number) => request(app).post(`${base}/games/snake/scores`).set(bearer(s)).send({ score });
const board = (s: TestSession) => request(app).get(`${base}/games/snake/leaderboard`).set(bearer(s));

describe('snake leaderboard', () => {
  it('starts empty', async () => {
    const owner = await signup();
    const res = await board(owner);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ top: [], me: null });
  });

  it('keeps each person’s best and counts games', async () => {
    const owner = await signup({ name: 'Olivia' });
    const first = await submit(owner, 120);
    expect(first.status).toBe(201);
    expect(first.body.personalBest).toBe(true);

    const lower = await submit(owner, 50);
    expect(lower.body.personalBest).toBe(false);

    const res = await board(owner);
    expect(res.body.top).toHaveLength(1);
    expect(res.body.top[0]).toMatchObject({ rank: 1, user: { name: 'Olivia' }, best: 120, games: 2 });
    expect(res.body.me).toMatchObject({ rank: 1, best: 120 });
  });

  it('does not count a zero as a personal best', async () => {
    const owner = await signup();
    expect((await submit(owner, 0)).body.personalBest).toBe(false);
    expect((await board(owner)).body.me).toMatchObject({ best: 0, games: 1 });
  });

  it('rejects impossible scores', async () => {
    const owner = await signup();
    expect((await submit(owner, 15)).status).toBe(400);
    expect((await submit(owner, -10)).status).toBe(400);
    expect((await submit(owner, SNAKE_MAX_SCORE + 10)).status).toBe(400);
    expect((await request(app).post(`${base}/games/snake/scores`).set(bearer(owner)).send({ score: 10, cheat: true })).status).toBe(400);
  });

  it('keeps workspaces apart', async () => {
    const a = await signup({ workspaceName: 'Alpha' });
    const b = await signup({ workspaceName: 'Beta' });
    await submit(a, 300);
    expect((await board(b)).body.top).toEqual([]);
  });

  it('requires a session', async () => {
    expect((await request(app).get(`${base}/games/snake/leaderboard`)).status).toBe(401);
  });
});
