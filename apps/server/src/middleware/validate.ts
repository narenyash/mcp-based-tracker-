import type { ZodType, ZodTypeDef } from 'zod';
import type { Request } from 'express';
import { PreconditionRequiredError, ValidationError } from '../errors/AppError';

/** Parses untrusted input with a shared zod schema; throws a 400 with per-field errors. */
export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
    );
  }
  return result.data;
}

/** Reads `If-Match: "<version>"` (or `W/"<version>"`). Required for every versioned write. */
export function requireIfMatch(req: Request): number {
  const raw = req.get('if-match');
  const match = raw?.match(/^(?:W\/)?"?(\d{1,10})"?$/);
  if (!match?.[1]) throw new PreconditionRequiredError();
  return Number(match[1]);
}

export function etag(version: number): string {
  return `"${version}"`;
}
