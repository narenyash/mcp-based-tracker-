import { z } from 'zod';

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a hex color like #4f46e5');

export const idParamsSchema = z.object({ id: objectIdSchema });
