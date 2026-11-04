import pino from 'pino';
import { env } from '../config/env';
import { getContext } from './requestContext';

/** URL segments that are themselves credentials (invite tokens, signed file links) never reach the logs. */
const SECRET_URL_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/^(\/api\/v1\/invites\/)[^/?#]+(\/preview)/, '$1[redacted]$2'],
  [/^(\/api\/v1\/files\/)[^/?#]+/, '$1[redacted]'],
];

export function redactUrl(url: string): string {
  return SECRET_URL_PATTERNS.reduce((u, [re, replacement]) => u.replace(re, replacement), url);
}

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  base: { service: 'teamtrack-server' },
  mixin() {
    const ctx = getContext();
    if (!ctx) return {};
    return { requestId: ctx.requestId, userId: ctx.userId, workspaceId: ctx.workspaceId };
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.token',
      '*.passwordHash',
    ],
    censor: '[redacted]',
  },
  ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
});
