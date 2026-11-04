import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { ERROR_CODES, IDEMPOTENCY_HEADER } from '@teamtrack/shared';
import { requireAuth } from '../auth/context';
import { AppError, ConflictError } from '../errors/AppError';
import { IdempotencyKey } from '../models/IdempotencyKey';
import { logger } from '../observability/logger';

const TTL_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,200}$/;

/**
 * Makes POSTs safe to retry: a request carrying `Idempotency-Key` runs once per user and key, and a
 * repeat gets the stored response (with `Idempotent-Replayed: true`) instead of creating a second record.
 * - Same key, different body or path: 422, the key was reused for another request.
 * - Same key while the first is still running: 409, retry shortly.
 * - Only 2xx responses are stored. Errors release the key so the client can retry with it.
 * Requests without the header pass through untouched. Must run after `authenticate`.
 */
export const idempotency: RequestHandler = async (req, res, next) => {
  const clientKey = req.get(IDEMPOTENCY_HEADER);
  if (req.method !== 'POST' || clientKey === undefined) return next();
  if (!KEY_PATTERN.test(clientKey)) {
    throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, `${IDEMPOTENCY_HEADER} must be 8-200 characters of [A-Za-z0-9_.:-]`);
  }

  const { userId } = requireAuth(req);
  const key = `${userId.toHexString()}:${clientKey}`;
  const path = req.originalUrl.split('?')[0] ?? req.originalUrl;
  // Raw-body routes (uploads) parse their body later, so for them the hash covers type and length only.
  const body = Buffer.isBuffer(req.body) || req.body === undefined ? null : req.body;
  const requestHash = createHash('sha256')
    .update(JSON.stringify([req.method, path, req.get('content-type') ?? '', req.get('content-length') ?? '', body]))
    .digest('hex');

  try {
    await IdempotencyKey.create({
      key,
      userId,
      method: req.method,
      path,
      requestHash,
      state: 'processing',
      expiresAt: new Date(Date.now() + TTL_MS),
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    const prior = await IdempotencyKey.findOne({ key }).lean();
    if (!prior) throw new ConflictError('Request in progress, retry shortly', ERROR_CODES.IDEMPOTENCY_IN_PROGRESS);
    if (prior.requestHash !== requestHash) {
      throw new AppError(422, ERROR_CODES.IDEMPOTENCY_KEY_REUSED, `${IDEMPOTENCY_HEADER} was already used for a different request`);
    }
    if (prior.state !== 'done' || prior.responseStatus === null) {
      throw new ConflictError('Request in progress, retry shortly', ERROR_CODES.IDEMPOTENCY_IN_PROGRESS);
    }
    res.setHeader('Idempotent-Replayed', 'true');
    if (prior.responseBody === null) return void res.status(prior.responseStatus).end();
    return void res.status(prior.responseStatus).json(prior.responseBody);
  }

  let settled = false;
  const settle = async (responseBody: unknown) => {
    if (settled) return;
    settled = true;
    try {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        await IdempotencyKey.updateOne({ key }, { $set: { state: 'done', responseStatus: res.statusCode, responseBody } });
      } else {
        await IdempotencyKey.deleteOne({ key, state: 'processing' });
      }
    } catch (err) {
      logger.warn({ err }, 'could not record idempotent response');
    }
  };

  // Store the response before it is sent, so a retry that races the reply already sees it.
  const json = res.json.bind(res);
  res.json = (payload: unknown) => {
    void settle(payload ?? null).finally(() => json(payload));
    return res;
  };
  // Bodiless replies (204). Errors also go through res.json (problem+json), which releases the key.
  res.on('finish', () => void settle(null));
  next();
};
