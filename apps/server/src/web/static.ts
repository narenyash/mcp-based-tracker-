import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type RequestHandler, type Router } from 'express';

/*
 * Serves the built web app from the API process, so a single-service host (Render) gives the browser one
 * origin: the SameSite=strict refresh cookie and same-origin Socket.io depend on that. The headers mirror
 * deploy/nginx.conf, which does the same job when the web app runs in its own nginx container.
 */

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // React and Excalidraw set inline styles.
  "style-src 'self' 'unsafe-inline'",
  // Signed S3 download URLs.
  "img-src 'self' data: blob: https://*.amazonaws.com",
  // Excalidraw's default font CDN.
  "font-src 'self' data: https://esm.sh",
  // 'self' covers same-origin ws:/wss: for Socket.io.
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const PAGE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-cache',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': CSP,
};

/** Paths the API owns; everything else is the web app. */
const API_PREFIXES = ['/api/', '/socket.io/'];
const API_PATHS = new Set(['/healthz', '/readyz', '/metrics']);
const isApiPath = (p: string) => API_PATHS.has(p) || API_PREFIXES.some((x) => p.startsWith(x));

export function webApp(dir: string): Router {
  const root = path.resolve(dir);
  const index = path.join(root, 'index.html');
  if (!existsSync(index)) throw new Error(`WEB_DIST_DIR has no index.html: ${root}`);

  const r = express.Router();
  // Content-hashed bundles never change: cache them forever, and 404 a missing one instead of serving the page.
  r.use(
    '/assets',
    express.static(path.join(root, 'assets'), {
      immutable: true,
      maxAge: '1y',
      index: false,
      fallthrough: false,
      setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
    }),
  );
  const page: RequestHandler = (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || isApiPath(req.path)) return next();
    res.set(PAGE_HEADERS);
    next();
  };
  r.use(page, express.static(root, { index: false, maxAge: 0 }));
  // Client-side routes fall back to index.html.
  r.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || isApiPath(req.path) || !req.accepts('html')) return next();
    res.sendFile(index);
  });
  return r;
}
