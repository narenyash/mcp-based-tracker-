import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { logger, redactUrl } from './observability/logger';
import { isDraining } from './observability/lifecycle';
import { enableMetrics, metricsHandler, metricsMiddleware } from './observability/metrics';
import { requestId } from './middleware/requestId';
import { errorHandler, notFoundHandler } from './middleware/error';
import { pingDb } from './db/connection';
import { storage } from './services/storage';
import { apiRouter } from './routes';
import { webApp } from './web/static';
import './modules/register';

const QUIET_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

export function createApp(): Express {
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(requestId);
  if (env.METRICS_TOKEN) {
    enableMetrics();
    app.use(metricsMiddleware);
  }
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      serializers: {
        req: (req: { url?: string }) => {
          if (req.url) req.url = redactUrl(req.url);
          return req;
        },
      },
      autoLogging: { ignore: (req) => QUIET_PATHS.has(req.url ?? '') },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );
  // The web app, when this process serves it (Dockerfile.render). Mounted before helmet: its pages carry
  // their own CSP, and API paths fall through untouched.
  if (env.WEB_DIST_DIR) app.use(webApp(env.WEB_DIST_DIR));

  // This server only speaks JSON (the SPA is served by nginx or the handler above), so the policy can deny
  // everything: a response rendered as a document by mistake can't load or run anything, or be framed.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
          frameAncestors: ["'none'"],
          sandbox: [],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
    }),
  );
  app.use(cors({ origin: env.CLIENT_URL, credentials: true, exposedHeaders: ['ETag', 'X-Request-Id'] }));
  // Only parses application/json; routes that take raw bodies (uploads) mount express.raw themselves.
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  // Readiness: Mongo reachable and not shutting down. Reports which drivers are active, never their config.
  app.get('/readyz', async (_req, res) => {
    const mongo = await pingDb();
    const ready = mongo && !isDraining();
    res.setHeader('Cache-Control', 'no-store');
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : isDraining() ? 'draining' : 'degraded',
      checks: { mongo },
      storage: storage.driver,
      mail: env.MAIL_TRANSPORT,
    });
  });
  if (env.METRICS_TOKEN) app.get('/metrics', metricsHandler);

  // API responses are per-user; keep them out of browser and proxy caches unless a handler says otherwise.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/v1', apiRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
