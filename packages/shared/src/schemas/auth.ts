import { z } from 'zod';
import { ROLES } from '../enums';
import { objectIdSchema } from './common';

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email').max(254);
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128, 'Use at most 128 characters');
export const personNameSchema = z.string().trim().min(1, 'Name is required').max(80);
export const workspaceSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/, 'Invalid workspace');

export const signupSchema = z.object({
  workspaceName: z.string().trim().min(2, 'At least 2 characters').max(60),
  name: personNameSchema,
  email: emailSchema,
  password: passwordSchema,
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(128),
  workspace: workspaceSlugSchema.optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const invitableRoleSchema = z.enum(ROLES).exclude(['owner']);

export const createInviteSchema = z.object({
  email: emailSchema,
  role: invitableRoleSchema,
  projectIds: z.array(objectIdSchema).max(50).default([]),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

export const inviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid invite link');

export const acceptInviteSchema = z.object({
  token: inviteTokenSchema,
  /** Required for a team join link; an email invite already knows its address and ignores this. */
  email: emailSchema.optional(),
  name: personNameSchema,
  password: passwordSchema,
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
