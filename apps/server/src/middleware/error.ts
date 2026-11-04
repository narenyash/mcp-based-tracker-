import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { ERROR_CODES, type Problem } from '@teamtrack/shared';
import { AppError, NotFoundError } from '../errors/AppError';
import { logger } from '../observability/logger';
import { isProd } from '../config/env';

const PROBLEM_BASE = 'https://teamtrack.dev/problems/';

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof mongoose.Error.VersionError) {
    return new AppError(409, ERROR_CODES.STALE_VERSION, 'This item was changed by someone else');
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const errors = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
    return new AppError(400, ERROR_CODES.VALIDATION_FAILED, 'Validation failed', { errors });
  }
  if (err instanceof mongoose.Error.CastError) {
    return new AppError(400, ERROR_CODES.VALIDATION_FAILED, `Invalid value for ${err.path}`);
  }
  if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
    return new AppError(409, ERROR_CODES.CONFLICT, 'A record with these values already exists');
  }
  if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.parse.failed') {
    return new AppError(400, ERROR_CODES.VALIDATION_FAILED, 'Malformed JSON body');
  }
  if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large') {
    return new AppError(413, ERROR_CODES.VALIDATION_FAILED, 'Request body too large');
  }
  return new AppError(500, ERROR_CODES.INTERNAL, 'Something went wrong');
}

export const notFoundHandler: RequestHandler = () => {
  throw new NotFoundError('Route');
};

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const appErr = toAppError(err);
  if (appErr.status >= 500) {
    logger.error({ err }, 'unhandled error');
  } else {
    logger.debug({ code: appErr.code, status: appErr.status }, appErr.message);
  }

  const body: Problem = {
    type: PROBLEM_BASE + appErr.code.toLowerCase(),
    title: appErr.message,
    status: appErr.status,
    code: appErr.code,
    requestId: req.requestId,
    ...appErr.extra,
  };
  if (!isProd && appErr.status >= 500 && err instanceof Error) body.detail = err.message;

  res.status(appErr.status).type('application/problem+json').json(body);
};
