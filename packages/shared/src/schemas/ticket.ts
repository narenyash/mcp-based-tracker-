import { z } from 'zod';
import type { StatusCategory } from '../enums';
import type { PersonRef, TaskDto } from '../types';
import { objectIdSchema, paginationQuerySchema } from './common';
import { statusIdSchema } from './task';

/* Phase 4: tickets (bugs, issues, requests). Schemas, inferred input types and DTOs. */

export const TICKET_TYPES = ['bug', 'issue', 'request', 'question', 'incident'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export const TICKET_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type TicketSeverity = (typeof TICKET_SEVERITIES)[number];

/** Numeric rank stored next to the severity so lists can sort by it. */
export const SEVERITY_RANK: Record<TicketSeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

/** Why a ticket was closed. Required whenever a ticket enters a done-category status. */
export const TICKET_RESOLUTIONS = ['fixed', 'wont_fix', 'duplicate', 'cannot_reproduce', 'by_design'] as const;
export type TicketResolution = (typeof TICKET_RESOLUTIONS)[number];

export const MAX_TICKET_LINKED_TASKS = 50;

/** Workspace-wide readable key, e.g. TCK-12. */
export const ticketKeySchema = z.string().regex(/^TCK-\d{1,9}$/i);

const title = z.string().trim().min(1, 'Title is required').max(200);
const longText = z.string().max(20_000);
const shortText = z.string().max(5_000);
const envValue = z.string().trim().max(300);

/** Where the problem happens. Every part is optional free text. */
export const ticketEnvironmentSchema = z
  .object({ browser: envValue, os: envValue, url: z.string().trim().max(2000), version: envValue })
  .partial();
export type TicketEnvironment = z.infer<typeof ticketEnvironmentSchema>;

export const createTicketSchema = z.object({
  title,
  description: longText.default(''),
  type: z.enum(TICKET_TYPES).default('bug'),
  severity: z.enum(TICKET_SEVERITIES).default('medium'),
  /** Must be an open (not done) status; defaults to the first status of the project's ticket workflow. */
  statusId: statusIdSchema.optional(),
  assigneeId: objectIdSchema.nullable().default(null),
  environment: ticketEnvironmentSchema.default({}),
  stepsToReproduce: shortText.default(''),
  expected: shortText.default(''),
  actual: shortText.default(''),
  labelIds: z.array(objectIdSchema).max(20).default([]),
});
export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export const updateTicketSchema = z
  .object({
    title,
    description: longText,
    type: z.enum(TICKET_TYPES),
    severity: z.enum(TICKET_SEVERITIES),
    assigneeId: objectIdSchema.nullable(),
    environment: ticketEnvironmentSchema,
    stepsToReproduce: shortText,
    expected: shortText,
    actual: shortText,
    labelIds: z.array(objectIdSchema).max(20),
    /** Only while resolved; reopening goes through /move. */
    resolution: z.enum(TICKET_RESOLUTIONS),
    duplicateOfId: objectIdSchema.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;

/**
 * Moves a ticket to a status and position (neighbour ids, as for tasks). Entering a done-category
 * status requires a resolution; leaving one reopens the ticket and clears it.
 */
export const moveTicketSchema = z.object({
  statusId: statusIdSchema,
  afterId: objectIdSchema.nullable().optional(),
  beforeId: objectIdSchema.nullable().optional(),
  resolution: z.enum(TICKET_RESOLUTIONS).optional(),
  duplicateOfId: objectIdSchema.optional(),
  /** Shown to the reporter in the "resolved" notification. */
  note: z.string().trim().max(2000).optional(),
});
export type MoveTicketInput = z.infer<typeof moveTicketSchema>;

const personFilter = z.union([z.literal('me'), objectIdSchema]);

export const TICKET_SORTS = ['updated', 'created', 'severity'] as const;

export const listTicketsQuerySchema = paginationQuerySchema.extend({
  projectId: objectIdSchema.optional(),
  assignee: personFilter.optional(),
  reporter: personFilter.optional(),
  state: z.enum(['open', 'done', 'all']).default('all'),
  type: z.enum(TICKET_TYPES).optional(),
  severity: z.enum(TICKET_SEVERITIES).optional(),
  statusId: statusIdSchema.optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(TICKET_SORTS).default('updated'),
});
export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;

export const linkTicketTaskSchema = z.object({ taskId: objectIdSchema });
export type LinkTicketTaskInput = z.infer<typeof linkTicketTaskSchema>;

export const ticketLinkParamsSchema = z.object({ id: objectIdSchema, taskId: objectIdSchema });

/* ------------------------------------------------------------------- DTOs */

/** A linked task as shown on a ticket. Deleted tasks drop out of this list. */
export interface LinkedTaskDto {
  id: string;
  key: string;
  title: string;
  projectId: string;
  statusId: string;
  statusCategory: StatusCategory;
}

export interface TicketDto {
  id: string;
  key: string;
  number: number;
  projectId: string;
  title: string;
  description: string;
  type: TicketType;
  severity: TicketSeverity;
  statusId: string;
  statusCategory: StatusCategory;
  assignee: PersonRef | null;
  reporter: PersonRef | null;
  environment: { browser: string; os: string; url: string; version: string };
  stepsToReproduce: string;
  expected: string;
  actual: string;
  resolution: TicketResolution | null;
  duplicateOf: { id: string; key: string } | null;
  resolvedAt: string | null;
  resolvedBy: PersonRef | null;
  reopenCount: number;
  labelIds: string[];
  linkedTasks: LinkedTaskDto[];
  rank: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface TicketBoardDto {
  tickets: TicketDto[];
  /** True when the project has more tickets than one board load returns. */
  truncated: boolean;
}

export interface ConvertTicketResultDto {
  ticket: TicketDto;
  task: TaskDto;
}
