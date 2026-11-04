import { z } from 'zod';
import { USER_STATUSES } from '../enums';
import { personNameSchema, invitableRoleSchema } from './auth';
import { paginationQuerySchema } from './common';

export const updateMeSchema = z.object({ name: personNameSchema });
export type UpdateMeInput = z.infer<typeof updateMeSchema>;

export const updateRoleSchema = z.object({ role: invitableRoleSchema });

export const updateStatusSchema = z.object({ status: z.enum(['active', 'suspended']) });

export const listUsersQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(80).optional(),
  status: z.enum(USER_STATUSES).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
