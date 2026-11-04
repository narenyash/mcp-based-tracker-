import type { Types } from 'mongoose';
import type { ActivityDto, AttachmentDto, CommentDto, PersonRef } from '@teamtrack/shared';
import type { AuthContext } from '../../auth/context';
import type { IActivity } from '../../models/Activity';
import type { IAttachment } from '../../models/Attachment';
import type { IComment } from '../../models/Comment';
import type { EntityInfo } from '../../services/entityAccess';
import { userRepository } from '../../repositories/userRepository';
import type { People } from '../dto';

/** Names for a set of user ids, resolved per request so renamed people show their current name. */
export async function loadPeople(workspaceId: Types.ObjectId, ids: Types.ObjectId[]): Promise<People> {
  const unique = new Map(ids.map((id) => [id.toHexString(), id]));
  if (!unique.size) return new Map();
  const users = await userRepository.findByIds(workspaceId, [...unique.values()]);
  return new Map(users.map((u) => [u._id.toHexString(), u]));
}

function ref(people: People, id: Types.ObjectId): PersonRef {
  const u = people.get(id.toHexString());
  return u ? { id: u._id.toHexString(), name: u.name } : { id: id.toHexString(), name: 'Removed user' };
}

/** Moderation rule shared by comments and attachments: the owner (while they can still contribute) or a moderator. */
export function canRemove(ctx: AuthContext, info: EntityInfo, ownerId: Types.ObjectId): boolean {
  return info.canManage || (info.canWrite && ownerId.equals(ctx.userId));
}

export function toCommentDto(c: IComment, people: People, ctx: AuthContext, info: EntityInfo): CommentDto {
  const deleted = !!c.deletedAt;
  return {
    id: c._id.toHexString(),
    entityType: c.entityType,
    entityId: c.entityId.toHexString(),
    parentId: c.parentId?.toHexString() ?? null,
    author: deleted ? null : ref(people, c.authorId),
    body: deleted ? '' : c.body,
    deleted,
    editedAt: deleted ? null : (c.editedAt?.toISOString() ?? null),
    replyCount: c.replyCount,
    createdAt: c.createdAt.toISOString(),
    version: c.version,
    canEdit: !deleted && info.canWrite && c.authorId.equals(ctx.userId),
    canDelete: !deleted && canRemove(ctx, info, c.authorId),
  };
}

export function toAttachmentDto(a: IAttachment, people: People, ctx: AuthContext, info: EntityInfo, urls: { url: string; downloadUrl: string }): AttachmentDto {
  return {
    id: a._id.toHexString(),
    entityType: a.entityType,
    entityId: a.entityId.toHexString(),
    fileName: a.fileName,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    image: a.image ? { width: a.image.width, height: a.image.height } : null,
    uploader: ref(people, a.uploaderId),
    createdAt: a.createdAt.toISOString(),
    ...urls,
    canDelete: canRemove(ctx, info, a.uploaderId),
  };
}

export function toActivityDto(a: IActivity, people: People): ActivityDto {
  return {
    id: a._id.toHexString(),
    projectId: a.projectId?.toHexString() ?? null,
    entityType: a.entityType,
    entityId: a.entityId.toHexString(),
    entityKey: a.entityKey,
    actor: ref(people, a.actorId),
    action: a.action,
    changes: a.changes.map((c) => ({ field: c.field, from: c.from, to: c.to })),
    at: a.at.toISOString(),
  };
}
