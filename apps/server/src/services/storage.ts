import { createHmac } from 'node:crypto';
import { Router } from 'express';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { env, isTest } from '../config/env';
import { safeEqual } from '../auth/tokens';
import { logger } from '../observability/logger';

/**
 * Object storage behind one small interface. Uploads go through the API (size and type are checked
 * server-side, and the shared bucket needs no CORS rules); downloads use short-lived signed URLs.
 *  - s3: the shared bucket, every key under `<S3_UPLOAD_PREFIX>/teamtrack/`.
 *  - memory: tests and machines without AWS credentials. Lost on restart.
 */
export interface ObjectStorage {
  readonly driver: 's3' | 'memory';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  head(key: string): Promise<{ size: number; contentType: string } | null>;
  remove(key: string): Promise<void>;
  /** URL the browser can GET for `ttlSec` (img src, download link). */
  signedUrl(key: string, opts?: { ttlSec?: number; downloadName?: string }): Promise<string>;
}

const DEFAULT_TTL = 300;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,200}$/;

/** Builds a namespaced key; every segment is validated so user input can never escape the prefix. */
export function storageKey(...segments: string[]): string {
  for (const s of segments) if (!SAFE_SEGMENT.test(s) || s === '.' || s === '..') throw new Error(`unsafe storage key segment: ${s}`);
  return [env.S3_UPLOAD_PREFIX.replace(/\/+$/, ''), 'teamtrack', ...segments].join('/');
}

const disposition = (name?: string) => (name ? `attachment; filename*=UTF-8''${encodeURIComponent(name)}` : undefined);

function s3Storage(bucket: string): ObjectStorage {
  const client = new S3Client({
    region: env.AWS_REGION,
    // Bounded so a stalled S3 connection fails the request instead of hanging it (the SDK has no default).
    requestHandler: new NodeHttpHandler({ connectionTimeout: 3000, requestTimeout: 15_000 }),
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } }
      : {}),
  });
  return {
    driver: 's3',
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return res.Body ? Buffer.from(await res.Body.transformToByteArray()) : null;
      } catch (err) {
        if ((err as { name?: string }).name === 'NoSuchKey') return null;
        throw err;
      }
    },
    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? 'application/octet-stream' };
      } catch (err) {
        if ((err as { name?: string }).name === 'NotFound') return null;
        throw err;
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    signedUrl(key, opts = {}) {
      const cmd = new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: disposition(opts.downloadName) });
      return getSignedUrl(client, cmd, { expiresIn: opts.ttlSec ?? DEFAULT_TTL });
    },
  };
}

/* ---- memory driver: signed URLs point at GET /api/v1/files/:token, an HMAC over key + expiry */

const objects = new Map<string, { body: Buffer; contentType: string }>();
const sign = (payload: string) => createHmac('sha256', env.JWT_ACCESS_SECRET).update(`files:${payload}`).digest('base64url');

function memoryStorage(): ObjectStorage {
  return {
    driver: 'memory',
    async put(key, body, contentType) {
      objects.set(key, { body, contentType });
    },
    async get(key) {
      return objects.get(key)?.body ?? null;
    },
    async head(key) {
      const o = objects.get(key);
      return o ? { size: o.body.length, contentType: o.contentType } : null;
    },
    async remove(key) {
      objects.delete(key);
    },
    async signedUrl(key, opts = {}) {
      const payload = Buffer.from(JSON.stringify({ k: key, e: Date.now() + (opts.ttlSec ?? DEFAULT_TTL) * 1000, n: opts.downloadName })).toString('base64url');
      return `/api/v1/files/${payload}.${sign(payload)}`;
    },
  };
}

/** Serves memory-driver objects for signed URLs. Mounted before authentication: the signature is the credential. */
export function filesRouter(): Router {
  const r = Router();
  r.get('/files/:token', (req, res) => {
    const [payload = '', sig = ''] = req.params.token.split('.');
    if (storage.driver !== 'memory' || !safeEqual(sig, sign(payload))) return void res.status(404).end();
    const { k, e, n } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { k: string; e: number; n?: string };
    const obj = objects.get(k);
    if (Date.now() > e || !obj) return void res.status(404).end();
    res.setHeader('Content-Type', obj.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    const d = disposition(n);
    if (d) res.setHeader('Content-Disposition', d);
    res.end(obj.body);
  });
  return r;
}

function pick(): ObjectStorage {
  const wanted = env.STORAGE_DRIVER ?? (isTest || !env.AWS_BUCKET_NAME ? 'memory' : 's3');
  if (wanted === 's3') {
    if (!env.AWS_BUCKET_NAME) throw new Error('STORAGE_DRIVER=s3 needs AWS_BUCKET_NAME');
    return s3Storage(env.AWS_BUCKET_NAME);
  }
  if (!isTest) logger.warn('file storage is in memory: uploads are lost on restart (set AWS_BUCKET_NAME for S3)');
  return memoryStorage();
}

export const storage: ObjectStorage = pick();
