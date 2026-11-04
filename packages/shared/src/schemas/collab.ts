import { z } from 'zod';
import { ENTITY_TYPES, type EntityType } from '../enums';
import type { PersonRef } from '../types';
import { objectIdSchema, paginationQuerySchema } from './common';

/* ---------------------------------------------------------------- limits */

export const MAX_COMMENT_LENGTH = 10_000;
export const MAX_MENTIONS = 50;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_ENTITY = 50;
export const MAX_FILE_NAME_LENGTH = 200;

/** What can be uploaded. The server identifies files by their bytes, never by name or Content-Type. */
export const ATTACHMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/csv'] as const;
export type AttachmentMimeType = (typeof ATTACHMENT_MIME_TYPES)[number];
export const IMAGE_MIME_TYPES: readonly AttachmentMimeType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/* -------------------------------------------------------------- mentions */

/**
 * Mentions are stored inline in the comment body as `@[Display Name](<24-hex user id>)`. The server
 * validates the ids and rewrites each token with the user's current name (or plain text if invalid).
 */
export const MENTION_PATTERN = /@\[([^\]\n]{1,80})\]\(([a-f\d]{24})\)/gi;

/** Builds a token. Brackets and newlines in names are replaced so the token always re-parses. */
export function mentionToken(name: string, userId: string): string {
  const safe = name.replace(/[[\]\n\r]/g, ' ').trim().slice(0, 80) || 'user';
  return `@[${safe}](${userId})`;
}

export type CommentSegment = { kind: 'text'; text: string } | { kind: 'mention'; name: string; userId: string };

/** Splits a body into text and mention segments, for rendering. */
export function parseMentions(body: string): CommentSegment[] {
  const out: CommentSegment[] = [];
  let last = 0;
  for (const m of body.matchAll(new RegExp(MENTION_PATTERN.source, 'gi'))) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'text', text: body.slice(last, at) });
    out.push({ kind: 'mention', name: m[1]!, userId: m[2]!.toLowerCase() });
    last = at + m[0].length;
  }
  if (last < body.length) out.push({ kind: 'text', text: body.slice(last) });
  return out;
}

/** Plain-text rendering (tokens become `@Name`), for excerpts and emails. */
export function mentionsToText(body: string): string {
  return body.replace(new RegExp(MENTION_PATTERN.source, 'gi'), (_m, name: string) => `@${name}`);
}

/* --------------------------------------------------------------- schemas */

const entityType = z.enum(ENTITY_TYPES);
export const entityRefSchema = z.object({ entityType, entityId: objectIdSchema });
export type EntityRef = z.infer<typeof entityRefSchema>;

const body = z
  .string()
  .max(MAX_COMMENT_LENGTH, `Comments can be at most ${MAX_COMMENT_LENGTH.toLocaleString('en')} characters`)
  .refine((s) => s.trim().length > 0, 'Write something first')
  .transform((s) => s.replace(/\r\n?/g, '\n').trimEnd());

export const listCommentsQuerySchema = paginationQuerySchema.extend(entityRefSchema.shape);
export type ListCommentsQuery = z.infer<typeof listCommentsQuerySchema>;

export const createCommentSchema = entityRefSchema.extend({
  body,
  /** Replies are one level deep: the parent must be a top-level comment on the same entity. */
  parentId: objectIdSchema.nullable().optional(),
});
export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const updateCommentSchema = z.object({ body }).strict();
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;

export const mentionableQuerySchema = entityRefSchema.extend({ q: z.string().trim().max(80).optional() });
export type MentionableQuery = z.infer<typeof mentionableQuerySchema>;

export const uploadAttachmentQuerySchema = entityRefSchema.extend({
  fileName: z.string().trim().min(1, 'File name is required').max(255),
});
export type UploadAttachmentQuery = z.infer<typeof uploadAttachmentQuerySchema>;

export const listAttachmentsQuerySchema = entityRefSchema;

/** Either one entity's history or a whole project's feed. */
export const listActivityQuerySchema = paginationQuerySchema
  .extend({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    entityType: entityType.optional(),
    entityId: objectIdSchema.optional(),
    projectId: objectIdSchema.optional(),
  })
  .refine((q) => (q.projectId ? !q.entityType && !q.entityId : !!q.entityType && !!q.entityId), {
    message: 'Pass entityType and entityId, or projectId',
    path: ['entityId'],
  });
export type ListActivityQuery = z.infer<typeof listActivityQuerySchema>;

/* ------------------------------------------------------------------ DTOs */

export interface CommentDto {
  id: string;
  entityType: EntityType;
  entityId: string;
  parentId: string | null;
  author: PersonRef | null;
  /** Empty when deleted. Mentions are inline tokens; render with parseMentions. */
  body: string;
  deleted: boolean;
  editedAt: string | null;
  replyCount: number;
  createdAt: string;
  version: number;
  /** For the viewer: may they edit / delete it? */
  canEdit: boolean;
  canDelete: boolean;
}

export interface MentionableUserDto {
  id: string;
  name: string;
  email: string;
}

export interface AttachmentDto {
  id: string;
  entityType: EntityType;
  entityId: string;
  fileName: string;
  mimeType: AttachmentMimeType;
  sizeBytes: number;
  image: { width: number; height: number } | null;
  uploader: PersonRef | null;
  createdAt: string;
  /** Short-lived (5 min) URL for viewing inline; refetch the list to renew. */
  url: string;
  /** Same, but downloads with the original file name. */
  downloadUrl: string;
  canDelete: boolean;
}

export interface ActivityChangeDto {
  field: string;
  from: string | null;
  to: string | null;
}

export interface ActivityDto {
  id: string;
  projectId: string | null;
  entityType: EntityType;
  entityId: string;
  entityKey: string;
  actor: PersonRef | null;
  /** created, updated, moved, deleted, commented, attached... */
  action: string;
  changes: ActivityChangeDto[];
  at: string;
}
