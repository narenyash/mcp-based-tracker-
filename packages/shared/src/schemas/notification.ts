import { z } from 'zod';
import { paginationQuerySchema } from './common';

export const listNotificationsQuerySchema = paginationQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  unread: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

/** Email preferences a user can change. In-app notifications are always on. */
export const updatePreferencesSchema = z
  .object({
    email: z
      .object({ assigned: z.boolean(), testing: z.boolean(), dueSoon: z.boolean(), mentioned: z.boolean() })
      .partial()
      .strict()
      .refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
  })
  .strict();
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;
