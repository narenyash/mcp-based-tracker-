import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { webApp } from '../src/web/static';

function site() {
  const dir = mkdtempSync(path.join(tmpdir(), 'tt-web-'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>TeamTrack</title>');
  writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  const app = express();
  app.use(webApp(dir));
  app.get('/api/v1/ping', (_req, res) => void res.json({ ok: true }));
  app.use((_req, res) => void res.status(404).json({ code: 'NOT_FOUND' }));
  return app;
}

describe('web app served by the API', () => {
  const app = site();

  it('serves client routes as index.html with the page CSP', async () => {
    const res = await request(app).get('/projects/123').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('TeamTrack');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('caches hashed assets forever and 404s a missing one', async () => {
    const ok = await request(app).get('/assets/app-abc123.js');
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toContain('immutable');
    expect((await request(app).get('/assets/missing.js')).status).toBe(404);
  });

  it('leaves API paths to the API', async () => {
    expect((await request(app).get('/api/v1/ping')).body).toEqual({ ok: true });
    const missing = await request(app).get('/api/v1/nope').set('Accept', 'text/html');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ code: 'NOT_FOUND' });
  });

  it('refuses to start without a build', () => {
    expect(() => webApp(mkdtempSync(path.join(tmpdir(), 'tt-empty-')))).toThrow(/index.html/);
  });
});
