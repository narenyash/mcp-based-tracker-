import { Types } from 'mongoose';
import {
  MAX_COMMENT_LENGTH,
  MAX_MENTIONS,
  MENTION_PATTERN,
  mentionsToText,
  mentionToken,
  type CommentChangedEvent,
  type CommentDto,
  type CreateCommentInput,
  type ListCommentsQuery,
  type MentionableQuery,
  type MentionableUserDto,
  type Page,
  type UpdateCommentInput,
} from '@teamtrack/shared';
import { withTransaction } from '../../db/transaction';
import { ForbiddenError, NotFoundError, ValidationError } from '../../errors/AppError';
import type { AuthContext } from '../../auth/context';
import type { IComment } from '../../models/Comment';
import { recordActivity } from '../../services/activity';
import { resolveEntity, type EntityInfo } from '../../services/entityAccess';
import { notifyMessage, type NotifyJob } from '../../services/notifier';
import { enqueue, type OutboxMessage } from '../../services/outbox';
import { realtime } from '../../services/realtime';
import { audienceOf, type Audience } from './audience';
import { canRemove, loadPeople, toCommentDto } from './collab.dto';
import { commentRepository } from './repositories';

const EXCERPT_LENGTH = 300;
const MENTIONABLE_LIMIT = 20;

/* ---------------------------------------------------------------- helpers */

/**
 * Validates mention tokens against the people who can see the entity. Valid tokens are rewritten with the
 * user's current name (so a token can't impersonate someone else's name); invalid ones become plain text.
 */
export function normalizeMentions(raw: string, audience: Audience): { body: string; mentionUserIds: Types.ObjectId[] } {
  const ids = new Map<string, Types.ObjectId>();
  const body = raw.replace(new RegExp(MENTION_PATTERN.source, 'gi'), (_m, name: string, id: string) => {
    const user = audience.get(id.toLowerCase());
    if (!user || (!ids.has(user._id.toHexString()) && ids.size >= MAX_MENTIONS)) return `@${name}`;
    ids.set(user._id.toHexString(), user._id);
    return mentionToken(user.name, user._id.toHexString());
  });
  if (body.length > MAX_COMMENT_LENGTH) throw new ValidationError([{ path: 'body', message: `Comments can be at most ${MAX_COMMENT_LENGTH.toLocaleString('en')} characters` }]);
  return { body, mentionUserIds: [...ids.values()] };
}

function excerpt(body: string): string {
  const text = mentionsToText(body).replace(/\s+/g, ' ').trim();
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1)}…` : text;
}

/** The entity behind a comment, with "can't see it" reported as the comment not existing. */
async function loadComment(ctx: AuthContext, id: string): Promise<{ comment: IComment; info: EntityInfo }> {
  const comment = await commentRepository.findById(ctx.workspaceId, id);
  if (!comment) throw new NotFoundError('Comment');
  try {
    return { comment, info: await resolveEntity(ctx, comment.entityType, comment.entityId) };
  } catch (err) {
    if (err instanceof NotFoundError) throw new NotFoundError('Comment');
    throw err;
  }
}

/**
 * Outbox notifications for a comment. Mentioned people get `mentioned`; with `participants`, everyone else
 * who follows the entity gets `comment_added`. Never the author, never someone who can't see it. Keys are
 * per comment + recipient + kind, so retries and edits never notify twice.
 */
function commentNotices(
  ctx: AuthContext,
  info: EntityInfo,
  comment: IComment,
  mentioned: Types.ObjectId[],
  participants: Types.ObjectId[],
  audience: Audience,
  actorName: string,
): OutboxMessage[] {
  const base: Omit<NotifyJob, 'userId' | 'type'> = {
    workspaceId: ctx.workspaceId.toHexString(),
    actor: { id: ctx.userId.toHexString(), name: actorName },
    projectId: info.projectId?.toHexString() ?? null,
    projectName: info.projectName,
    subject: { type: info.type, id: info.id.toHexString(), key: info.key, title: info.title },
    path: info.path,
    note: excerpt(comment.body),
  };
  const done = new Set([ctx.userId.toHexString()]);
  const out: OutboxMessage[] = [];
  const add = (userId: Types.ObjectId, type: 'mentioned' | 'comment_added') => {
    const hex = userId.toHexString();
    if (done.has(hex) || !audience.has(hex)) return;
    done.add(hex);
    out.push(notifyMessage({ ...base, userId: hex, type }, `comment:${comment._id.toHexString()}:${type}:${hex}`));
  };
  for (const id of mentioned) add(id, 'mentioned');
  for (const id of participants) add(id, 'comment_added');
  return out;
}

/** Tells viewers of the project to refetch the thread. Call after commit; project-less entities have no room. */
function broadcast(ctx: AuthContext, info: EntityInfo, commentId: Types.ObjectId, kind: CommentChangedEvent['kind']): void {
  if (!info.projectId) return;
  realtime.toProject(info.projectId.toHexString(), 'comment:changed', {
    projectId: info.projectId.toHexString(),
    entityType: info.type,
    entityId: info.id.toHexString(),
    commentId: commentId.toHexString(),
    kind,
    actorId: ctx.userId.toHexString(),
  });
}

async function actorName(ctx: AuthContext, audience: Audience): Promise<string> {
  const me = audience.get(ctx.userId.toHexString()) ?? (await loadPeople(ctx.workspaceId, [ctx.userId])).get(ctx.userId.toHexString());
  return me?.name ?? 'Someone';
}

/* ---------------------------------------------------------------- service */

export const commentsService = {
  async list(ctx: AuthContext, q: ListCommentsQuery): Promise<Page<CommentDto>> {
    const info = await resolveEntity(ctx, q.entityType, q.entityId);
    const page = await commentRepository.thread({ workspaceId: ctx.workspaceId, entityType: info.type, entityId: info.id }, q.limit, q.cursor);
    const people = await loadPeople(ctx.workspaceId, page.items.map((c) => c.authorId));
    return { items: page.items.map((c) => toCommentDto(c, people, ctx, info)), nextCursor: page.nextCursor };
  },

  async create(ctx: AuthContext, input: CreateCommentInput): Promise<CommentDto> {
    const info = await resolveEntity(ctx, input.entityType, input.entityId);
    if (!info.canWrite) throw new ForbiddenError('You can view this but not comment on it');

    const parentId = input.parentId ? new Types.ObjectId(input.parentId) : null;
    const badParent = (message: string) => new ValidationError([{ path: 'parentId', message }]);
    if (parentId) {
      const parent = await commentRepository.findById(ctx.workspaceId, parentId);
      if (!parent || parent.entityType !== info.type || !parent.entityId.equals(info.id)) throw badParent('That comment no longer exists');
      if (parent.parentId) throw badParent('Replies are one level deep: reply to the original comment');
    }

    const audience = await audienceOf(ctx, info);
    const { body, mentionUserIds } = normalizeMentions(input.body, audience);
    const name = await actorName(ctx, audience);
    // Generated once, so the dedupe keys stay the same if the driver retries the transaction.
    const id = new Types.ObjectId();

    const comment = await withTransaction(async (session) => {
      if (parentId) {
        // Re-checked inside the transaction: the parent may have been deleted since.
        if (!(await commentRepository.findById(ctx.workspaceId, parentId, session))) throw badParent('That comment no longer exists');
        await commentRepository.adjustReplies(ctx.workspaceId, parentId, 1, session);
      }
      const created = await commentRepository.create(
        {
          _id: id,
          workspaceId: ctx.workspaceId,
          projectId: info.projectId,
          entityType: info.type,
          entityId: info.id,
          parentId,
          authorId: ctx.userId,
          body,
          mentionUserIds,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        } as Partial<IComment>,
        session,
      );
      await recordActivity(session, {
        workspaceId: ctx.workspaceId,
        projectId: info.projectId,
        entityType: info.type,
        entityId: info.id,
        entityKey: info.key,
        actorId: ctx.userId,
        action: 'commented',
      });
      await enqueue(session, commentNotices(ctx, info, created, mentionUserIds, info.participants, audience, name));
      return created;
    });

    broadcast(ctx, info, comment._id, 'created');
    return toCommentDto(comment, new Map([[ctx.userId.toHexString(), { _id: ctx.userId, name }]]), ctx, info);
  },

  async update(ctx: AuthContext, id: string, input: UpdateCommentInput, expectedVersion: number): Promise<CommentDto> {
    const { comment, info } = await loadComment(ctx, id);
    if (!comment.authorId.equals(ctx.userId) || !info.canWrite) throw new ForbiddenError('Only the author can edit this comment');

    const audience = await audienceOf(ctx, info);
    const { body, mentionUserIds } = normalizeMentions(input.body, audience);
    const name = await actorName(ctx, audience);
    // Only people newly mentioned by the edit hear about it.
    const before = new Set(comment.mentionUserIds.map((m) => m.toHexString()));
    const added = mentionUserIds.filter((m) => !before.has(m.toHexString()));

    const updated = await withTransaction(async (session) => {
      const doc = await commentRepository.updateBody(ctx.workspaceId, comment._id, expectedVersion, { body, mentionUserIds }, ctx.userId, session);
      await enqueue(session, commentNotices(ctx, info, doc, added, [], audience, name));
      return doc;
    });

    broadcast(ctx, info, updated._id, 'updated');
    return toCommentDto(updated, new Map([[ctx.userId.toHexString(), { _id: ctx.userId, name }]]), ctx, info);
  },

  /** Soft delete. Replies stay; the parent then shows as "deleted" while it has any. */
  async remove(ctx: AuthContext, id: string): Promise<void> {
    const { comment, info } = await loadComment(ctx, id);
    if (!canRemove(ctx, info, comment.authorId)) throw new ForbiddenError('Only the author or a project lead can delete this comment');

    await withTransaction(async (session) => {
      if (!(await commentRepository.softDelete(ctx.workspaceId, comment._id, ctx.userId, session))) throw new NotFoundError('Comment');
      if (comment.parentId) await commentRepository.adjustReplies(ctx.workspaceId, comment.parentId, -1, session);
    });
    broadcast(ctx, info, comment._id, 'deleted');
  },

  /** People the caller can @-mention here (everyone who can see it, except the caller), for autocomplete. */
  async mentionable(ctx: AuthContext, q: MentionableQuery): Promise<MentionableUserDto[]> {
    const info = await resolveEntity(ctx, q.entityType, q.entityId);
    const audience = await audienceOf(ctx, info);
    const needle = q.q?.toLowerCase();
    const matches = (name: string, email: string) =>
      !needle || email.toLowerCase().startsWith(needle) || name.toLowerCase().split(/\s+/).some((w) => w.startsWith(needle)) || name.toLowerCase().startsWith(needle);
    return [...audience.values()]
      .filter((u) => !u._id.equals(ctx.userId) && matches(u.name, u.email))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MENTIONABLE_LIMIT)
      .map((u) => ({ id: u._id.toHexString(), name: u.name, email: u.email }));
  },
};
