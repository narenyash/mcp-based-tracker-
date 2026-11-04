import express, { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { ERROR_CODES, WHITEBOARD_IMAGE_TYPES, WHITEBOARD_LIMITS } from '@teamtrack/shared';
import { env } from '../../config/env';
import { AppError } from '../../errors/AppError';
import { logger } from '../../observability/logger';
import { boardsController } from './boards.controller';

/*
 * Scene saves are the one endpoint that inflates and parses up to MAX_INFLATED_BYTES of JSON on the
 * event loop, so they get their own budget on top of the API limiter:
 *  - SCENE_SAVES_PER_MIN per user (autosave runs at most every 2 s per open tab);
 *  - one save in flight per user, from the start of the body upload to the response.
 * Both are per instance (in memory); the cost they bound is per instance too.
 */
const SCENE_SAVES_PER_MIN = 60;

const userKey = (req: express.Request) => (req.auth ? `u:${req.auth.userId.toHexString()}` : `ip:${req.ip ?? ''}`);

const sceneSaveLimiter: RequestHandler = env.RATE_LIMIT_ENABLED
  ? rateLimit({
      windowMs: 60_000,
      limit: SCENE_SAVES_PER_MIN,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: userKey,
      handler: (req, _res, next) => {
        logger.warn({ limiter: 'board-scene', userId: req.auth?.userId.toHexString(), path: req.path }, 'rate limit exceeded');
        next(new AppError(429, ERROR_CODES.RATE_LIMITED, 'Too many saves, slow down'));
      },
    })
  : (_req, _res, next) => next();

const savesInFlight = new Set<string>();

/** Rejects a second concurrent scene save from the same user (the client retries shortly). */
export const oneSceneSaveAtATime: RequestHandler = (req, res, next) => {
  const key = userKey(req);
  if (savesInFlight.has(key)) {
    res.setHeader('Retry-After', '2');
    return next(new AppError(429, ERROR_CODES.RATE_LIMITED, 'Another save of yours is still in progress. Try again in a moment.'));
  }
  savesInFlight.add(key);
  // 'close' fires after the response is sent or when the client goes away, whichever comes first.
  res.once('close', () => savesInFlight.delete(key));
  next();
};

/** Phase 7: Excalidraw whiteboards, autosave, realtime sync, discussion. Mounted after authentication in src/routes.ts. */
export function boardsRouter(): Router {
  const r = Router();
  // Binary bodies only where needed. The global JSON parser (1 MB) skips these content types.
  const image = (limit: number) => express.raw({ type: [...WHITEBOARD_IMAGE_TYPES, 'application/octet-stream'], limit });
  const gzipJson = express.raw({ type: 'application/gzip', limit: WHITEBOARD_LIMITS.maxSceneBytes });

  r.get('/boards', boardsController.list);
  r.post('/boards', boardsController.create);
  r.get('/boards/:id', boardsController.get);
  r.patch('/boards/:id', boardsController.update);
  r.delete('/boards/:id', boardsController.remove);
  r.put('/boards/:id/scene', sceneSaveLimiter, oneSceneSaveAtATime, gzipJson, boardsController.saveScene);
  r.get('/boards/:id/snapshots', boardsController.snapshots);
  r.post('/boards/:id/snapshots/:snapshotId/restore', boardsController.restore);
  r.post('/boards/:id/files', image(WHITEBOARD_LIMITS.maxImageBytes), boardsController.uploadFile);
  r.get('/boards/:id/files/:fileId', boardsController.file);
  r.get('/boards/:id/files/:fileId/content', boardsController.fileContent);
  r.put('/boards/:id/thumbnail', image(WHITEBOARD_LIMITS.maxThumbnailBytes), boardsController.setThumbnail);
  return r;
}
