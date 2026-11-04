import { isIPv6 } from 'node:net';
import { rateLimit, type Store, type Options, type ClientRateLimitInfo } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import { ERROR_CODES } from '@teamtrack/shared';
import { env } from '../config/env';
import { RateLimitHit } from '../models/RateLimitHit';
import { AppError } from '../errors/AppError';
import { logger } from '../observability/logger';

/** Fixed-window counter in Mongo so limits hold across multiple server instances. */
class MongoStore implements Store {
  localKeys = false;
  private windowMs = 60_000;
  constructor(public prefix: string) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const now = new Date();
    const k = this.prefix + key;
    const live = await RateLimitHit.findOneAndUpdate(
      { key: k, expiresAt: { $gt: now } },
      { $inc: { count: 1 } },
      { new: true },
    ).lean();
    if (live) return { totalHits: live.count, resetTime: live.expiresAt };

    const resetTime = new Date(now.getTime() + this.windowMs);
    try {
      await RateLimitHit.updateOne({ key: k }, { $set: { count: 1, expiresAt: resetTime } }, { upsert: true });
    } catch (err) {
      // Two first-hits raced on the upsert; the loser simply counts against the winner's window.
      if ((err as { code?: number }).code !== 11000) throw err;
      return this.increment(key);
    }
    return { totalHits: 1, resetTime };
  }

  async decrement(key: string): Promise<void> {
    await RateLimitHit.updateOne({ key: this.prefix + key, count: { $gt: 0 } }, { $inc: { count: -1 } });
  }

  async resetKey(key: string): Promise<void> {
    await RateLimitHit.deleteOne({ key: this.prefix + key });
  }
}

/**
 * Client key for per-IP limits. IPv6 clients usually own a whole /64, so keying on the full address
 * would let one client rotate through 2^64 keys; collapse it to the /64 prefix instead.
 * Needs TRUST_PROXY set correctly behind nginx / a load balancer, or every client shares one IP.
 */
export function clientIpKey(req: Request): string {
  const ip = req.ip ?? '';
  if (!isIPv6(ip) || ip.toLowerCase().startsWith('::ffff:')) return ip || 'unknown';
  const [head = '', tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g || '0', 16).toString(16))
    .join(':')}::/64`;
}

const normalisedEmail = (req: Request): string =>
  typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';

const passThrough: RequestHandler = (_req, _res, next) => next();

interface LimiterOptions {
  keyGenerator?: (req: Request) => string;
  /** Only failed responses (status >= 400) count, so legitimate use never eats into the budget. */
  failuresOnly?: boolean;
}

function limiter(name: string, limit: number, windowMs: number, opts: LimiterOptions = {}): RequestHandler {
  if (!env.RATE_LIMIT_ENABLED) return passThrough;
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: new MongoStore(`${name}:`),
    keyGenerator: opts.keyGenerator ?? clientIpKey,
    skipSuccessfulRequests: opts.failuresOnly ?? false,
    // Fail open: if Mongo is unreachable the request fails on its own anyway, and a limiter outage
    // must not turn into a full API outage.
    passOnStoreError: true,
    handler: (req, _res, next) => {
      logger.warn({ limiter: name, ip: req.ip, path: req.path }, 'rate limit exceeded');
      next(new AppError(429, ERROR_CODES.RATE_LIMITED, 'Too many requests, slow down'));
    },
  });
}

/** Runs limiters in order; the first one to reject wins. */
function chain(...handlers: RequestHandler[]): RequestHandler {
  const active = handlers.filter((h) => h !== passThrough);
  if (active.length === 0) return passThrough;
  return (req, res, next) => {
    let i = 0;
    const step = (err?: unknown) => {
      if (err || i === active.length) return next(err);
      active[i++]!(req, res, step);
    };
    step();
  };
}

/**
 * Brute-force protection for password login:
 *  - per IP + email, failed attempts only: slows guessing one account without locking its owner out;
 *  - per IP, all attempts: stops one client spraying many accounts (credential stuffing).
 * These are the only brute-force throttle: the per-account failure counter (userRepository) is a
 * signal, not a lock, so a stranger can never lock the real owner out of their account.
 */
export const loginLimiter = chain(
  limiter('login-ip', 50, 15 * 60_000),
  limiter('login', 10, 15 * 60_000, { keyGenerator: (req) => `${clientIpKey(req)}|${normalisedEmail(req)}`, failuresOnly: true }),
);

/** Unauthenticated auth endpoints (signup, refresh, logout, invite preview/accept): per IP. */
export const authLimiter = limiter('auth', 30, 60_000);

/** Authenticated API: per user, so a shared office NAT doesn't pool everyone's budget. */
export const apiLimiter = limiter('api', 300, 60_000, {
  keyGenerator: (req) => (req.auth ? `u:${req.auth.userId.toHexString()}` : `ip:${clientIpKey(req)}`),
});
