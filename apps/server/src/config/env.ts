import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv, parse as parseDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Env sources, highest priority first:
 *   1. real process env (CI, hosting platform, tests)
 *   2. apps/server/.env, this app's own settings
 *   3. apps/.env, shared with other apps (billing, etc.). Only the allow-listed keys below are
 *      taken from it, so its PORT / JWT_SECRET / FRONTEND_URL can't silently reconfigure this server.
 */
loadDotenv({ path: resolve('.env'), quiet: true });

const SHARED_KEYS = [
  'MONGODB_DIRECT_URI',
  'MONGODB_URI',
  'MONGODB_DB_NAME',
  'AWS_REGION',
  'AWS_BUCKET_NAME',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'S3_UPLOAD_PREFIX',
] as const;

const sharedEnvPath = resolve('../.env');
if (existsSync(sharedEnvPath)) {
  const shared = parseDotenv(readFileSync(sharedEnvPath));
  for (const key of SHARED_KEYS) {
    if (process.env[key] === undefined && shared[key] !== undefined) process.env[key] = shared[key];
  }
}

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const mongoUri = z.string().regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb:// or mongodb+srv:// URI');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CLIENT_URL: z.string().url().default('http://localhost:5173'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  /** Explicit app URI (tests, dev:memory, dedicated cluster). Falls back to the shared MONGODB_* keys. */
  MONGO_URI: mongoUri.optional(),
  MONGO_DB_NAME: z.string().optional(),
  MONGODB_DIRECT_URI: mongoUri.optional(),
  MONGODB_URI: mongoUri.optional(),
  MONGODB_DB_NAME: z.string().optional(),
  /** Every collection is prefixed so TeamTrack can live in a database shared with other apps. */
  COLLECTION_PREFIX: z.string().regex(/^[a-z][a-z0-9]*_$/, 'lowercase, ending in _').default('tt_'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters (set it in apps/server/.env)'),
  JWT_ACCESS_KID: z.string().min(1).default('k1'),
  JWT_PREVIOUS_KEYS: z.string().default(''),
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),

  ALLOW_WORKSPACE_SIGNUP: bool.default('true'),
  RATE_LIMIT_ENABLED: bool.default('true'),

  MAIL_TRANSPORT: z.enum(['smtp', 'json']).default('smtp'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: bool.default('false'),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  MAIL_FROM: z.string().min(3).default('TeamTrack <no-reply@teamtrack.local>'),
  /** Dev/staging only: deliver every email to this one inbox (original recipient shown in the subject). */
  MAIL_REDIRECT_TO: z.string().email().optional(),

  // S3 (image uploads, Phase 5). The bucket is shared, so all keys live under <prefix>/teamtrack/.
  AWS_REGION: z.string().default('ap-south-1'),
  AWS_BUCKET_NAME: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  S3_UPLOAD_PREFIX: z.string().default('images'),
  /** Defaults to s3 when AWS_BUCKET_NAME is set, otherwise memory (and always memory in tests). */
  STORAGE_DRIVER: z.enum(['s3', 'memory']).optional(),
  /** Lets a production build run on memory storage. Only for the local prod-like docker stack. */
  ALLOW_MEMORY_STORAGE: bool.default('false'),
  /** Built web app (apps/web/dist) to serve from this process, for single-service hosts. Unset: nginx serves it. */
  WEB_DIST_DIR: z.string().min(1).optional(),

  /** Bearer token for GET /metrics (Prometheus text). Unset = the endpoint does not exist. */
  METRICS_TOKEN: z.string().min(16, 'METRICS_TOKEN must be at least 16 characters').optional(),
  /** Hard deadline for graceful shutdown; keep it below the orchestrator's kill grace period. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(10_000),
});

export type Env = z.infer<typeof schema> & { mongo: { uri: string; dbName: string | undefined } };

const refined = schema.superRefine((e, ctx) => {
  if (e.MAIL_TRANSPORT === 'smtp' && e.SMTP_USER && !e.SMTP_PASS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMTP_PASS'],
      message: `SMTP_USER is ${e.SMTP_USER} but SMTP_PASS is empty. For Gmail, create an app password (Google Account > Security > App passwords) and set SMTP_PASS in apps/server/.env, or set MAIL_TRANSPORT=json to print emails instead`,
    });
  }
  for (const pair of e.JWT_PREVIOUS_KEYS.split(',').filter(Boolean)) {
    const idx = pair.indexOf(':');
    if (idx <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['JWT_PREVIOUS_KEYS'], message: 'must be a comma-separated list of kid:secret pairs' });
    } else if (pair.length - idx - 1 < 32) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['JWT_PREVIOUS_KEYS'], message: `the secret for kid ${pair.slice(0, idx)} must be at least 32 characters, like JWT_ACCESS_SECRET` });
    }
  }
});

/** Production-only rules that depend on whether a key was set at all, not just on its parsed value. */
function productionIssues(e: z.infer<typeof schema>, source: NodeJS.ProcessEnv): string[] {
  if (e.NODE_ENV !== 'production') return [];
  const issues: string[] = [];
  const unset = (key: string) => source[key] === undefined || source[key] === '';
  if (e.MAIL_REDIRECT_TO) issues.push('MAIL_REDIRECT_TO: must not be set in production (every email would go to one inbox)');
  if (unset('CLIENT_URL')) issues.push('CLIENT_URL: required in production (the public URL of the web app, used for CORS and email links)');
  if (unset('TRUST_PROXY')) issues.push('TRUST_PROXY: set it explicitly in production (the number of proxies in front of the app, 0 if none), or client IPs and rate limits are wrong');
  const driver = e.STORAGE_DRIVER ?? (e.AWS_BUCKET_NAME ? 's3' : 'memory');
  if (driver === 'memory' && !e.ALLOW_MEMORY_STORAGE) {
    issues.push('STORAGE_DRIVER: memory storage loses every upload on restart; set AWS_BUCKET_NAME (and STORAGE_DRIVER=s3), or ALLOW_MEMORY_STORAGE=true for a throwaway local stack');
  }
  return issues.map((i) => `  - ${i}`);
}

/** Validates an environment; returns the parsed config or the list of problems. Exported for tests. */
export function validateEnv(source: NodeJS.ProcessEnv): { env: Env; issues: [] } | { env: undefined; issues: string[] } {
  const parsed = refined.safeParse(source);
  const issues = parsed.success ? productionIssues(parsed.data, source) : parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);

  let mongo: Env['mongo'] | undefined;
  if (parsed.success) {
    const e = parsed.data;
    // An explicit MONGO_URI is self-contained; the shared keys bring their own db name.
    if (e.MONGO_URI) mongo = { uri: e.MONGO_URI, dbName: e.MONGO_DB_NAME };
    else if (e.MONGODB_DIRECT_URI ?? e.MONGODB_URI) mongo = { uri: (e.MONGODB_DIRECT_URI ?? e.MONGODB_URI)!, dbName: e.MONGODB_DB_NAME };
    else issues.push('  - MONGO_URI: set MONGO_URI, or MONGODB_DIRECT_URI / MONGODB_URI in apps/.env');
  }

  if (!parsed.success || !mongo || issues.length) return { env: undefined, issues };
  return { env: { ...parsed.data, mongo }, issues: [] };
}

function loadEnv(): Env {
  const result = validateEnv(process.env);
  if (!result.env) {
    // Fail fast: a misconfigured server must never start.
    console.error(`Invalid environment configuration:\n${result.issues.join('\n')}`);
    process.exit(1);
  }
  return result.env;
}

export const env = loadEnv();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** kid -> secret map used to verify access tokens (current key + keys being rotated out). */
export const jwtKeys: ReadonlyMap<string, string> = (() => {
  const keys = new Map<string, string>([[env.JWT_ACCESS_KID, env.JWT_ACCESS_SECRET]]);
  for (const pair of env.JWT_PREVIOUS_KEYS.split(',').filter(Boolean)) {
    const idx = pair.indexOf(':');
    if (idx > 0) keys.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
  return keys;
})();

/** Physical collection name for a logical one, e.g. `users` -> `tt_users`. */
export const collectionName = (logical: string): string => env.COLLECTION_PREFIX + logical;
