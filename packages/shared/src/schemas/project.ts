import { z } from 'zod';
import { PROJECT_ROLES, PROJECT_STATUSES, PROJECT_VISIBILITIES } from '../enums';
import { hexColorSchema, objectIdSchema, paginationQuerySchema } from './common';

export const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, '2-10 letters/digits, starting with a letter');

export const createProjectSchema = z.object({
  key: projectKeySchema,
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(2000).default(''),
  color: hexColorSchema.default('#525252'),
  visibility: z.enum(PROJECT_VISIBILITIES).default('workspace'),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(2000),
    color: hexColorSchema,
    visibility: z.enum(PROJECT_VISIBILITIES),
    status: z.enum(PROJECT_STATUSES),
    leadId: objectIdSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const listProjectsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(PROJECT_STATUSES).default('active'),
});

export const addMemberSchema = z.object({
  userId: objectIdSchema,
  role: z.enum(PROJECT_ROLES).default('member'),
});

export const updateMemberSchema = z.object({ role: z.enum(PROJECT_ROLES) });

export const memberParamsSchema = z.object({ id: objectIdSchema, userId: objectIdSchema });
