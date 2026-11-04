import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { SOCKET_ID_HEADER } from '@teamtrack/shared';
import { runWithContext, type RequestContext } from '../observability/requestContext';

const VALID_ID = /^[A-Za-z0-9._-]{8,128}$/;
const VALID_SOCKET_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Accepts a well-formed upstream X-Request-Id or generates one, and opens the request's ALS context. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  const id = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  const ctx: RequestContext = { requestId: id };
  const socketId = req.get(SOCKET_ID_HEADER);
  if (socketId && VALID_SOCKET_ID.test(socketId)) ctx.socketId = socketId;
  runWithContext(ctx, () => next());
};
