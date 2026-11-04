import { isAxiosError } from 'axios';
import type { Problem } from '@teamtrack/shared';
import type { ZodType, ZodTypeDef } from 'zod';

export function problemOf(err: unknown): Problem | null {
  if (isAxiosError(err) && err.response?.data && typeof err.response.data === 'object') {
    return err.response.data as Problem;
  }
  return null;
}

export function errorMessage(err: unknown): string {
  const p = problemOf(err);
  if (p) return p.title;
  if (isAxiosError(err) && !err.response) return 'Network error. Check your connection.';
  return 'Something went wrong';
}

export type FieldErrors = Record<string, string>;

export function serverFieldErrors(err: unknown): FieldErrors {
  const out: FieldErrors = {};
  for (const e of problemOf(err)?.errors ?? []) out[e.path] ??= e.message;
  return out;
}

/** Client-side validation with the same zod schema the server uses. */
export function validate<T>(schema: ZodType<T, ZodTypeDef, unknown>, data: unknown): { data: T } | { errors: FieldErrors } {
  const r = schema.safeParse(data);
  if (r.success) return { data: r.data };
  const errors: FieldErrors = {};
  for (const i of r.error.issues) errors[i.path.join('.')] ??= i.message;
  return { errors };
}
