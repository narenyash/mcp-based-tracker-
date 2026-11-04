import { createHash, randomUUID } from 'node:crypto';
import { ERROR_CODES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_ENTITY, type AttachmentDto, type EntityRef, type UploadAttachmentQuery } from '@teamtrack/shared';
import { withTransaction } from '../../db/transaction';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors/AppError';
import type { AuthContext } from '../../auth/context';
import type { IAttachment } from '../../models/Attachment';
import { recordActivity } from '../../services/activity';
import { resolveEntity, type EntityInfo } from '../../services/entityAccess';
import { storage, storageKey } from '../../services/storage';
import { logger } from '../../observability/logger';
import { canRemove, loadPeople, toAttachmentDto } from './collab.dto';
import { detectFile, displayFileName, keySafeName, UnreadableImageError } from './fileTypes';
import { attachmentRepository } from './repositories';

const URL_TTL_SEC = 300;
const MB = MAX_ATTACHMENT_BYTES / 1024 / 1024;

const full = () => new ConflictError(`This item already has ${MAX_ATTACHMENTS_PER_ENTITY} attachments. Remove one to add another.`);

async function urlsFor(a: IAttachment): Promise<{ url: string; downloadUrl: string }> {
  const [url, downloadUrl] = await Promise.all([
    storage.signedUrl(a.storageKey, { ttlSec: URL_TTL_SEC }),
    storage.signedUrl(a.storageKey, { ttlSec: URL_TTL_SEC, downloadName: a.fileName }),
  ]);
  return { url, downloadUrl };
}

async function toDtos(ctx: AuthContext, info: EntityInfo, docs: IAttachment[]): Promise<AttachmentDto[]> {
  const [people, urls] = await Promise.all([loadPeople(ctx.workspaceId, docs.map((d) => d.uploaderId)), Promise.all(docs.map(urlsFor))]);
  return docs.map((d, i) => toAttachmentDto(d, people, ctx, info, urls[i]!));
}

/** Best-effort object cleanup; an orphaned object is only wasted space, never visible. */
async function removeObject(key: string): Promise<void> {
  try {
    await storage.remove(key);
  } catch (err) {
    logger.warn({ err, key }, 'failed to remove stored object');
  }
}

export const attachmentsService = {
  async list(ctx: AuthContext, q: EntityRef): Promise<AttachmentDto[]> {
    const info = await resolveEntity(ctx, q.entityType, q.entityId);
    const docs = await attachmentRepository.listForEntity({ workspaceId: ctx.workspaceId, entityType: info.type, entityId: info.id }, MAX_ATTACHMENTS_PER_ENTITY);
    return toDtos(ctx, info, docs);
  },

  /**
   * Stores an uploaded file. The type comes from the bytes (magic numbers), never from the name or header.
   * The object is written first, then the record in a transaction; if that fails the object is removed.
   */
  async upload(ctx: AuthContext, q: UploadAttachmentQuery, body: unknown): Promise<AttachmentDto> {
    const info = await resolveEntity(ctx, q.entityType, q.entityId);
    if (!info.canWrite) throw new ForbiddenError('You can view this but not attach files to it');
    if (!Buffer.isBuffer(body) || body.length === 0) throw new ValidationError([{ path: 'body', message: 'Send the file as the request body' }]);
    if (body.length > MAX_ATTACHMENT_BYTES) throw new AppError(413, ERROR_CODES.VALIDATION_FAILED, `Files can be at most ${MB} MB`);

    let detected;
    try {
      detected = detectFile(body, q.fileName);
    } catch (err) {
      if (err instanceof UnreadableImageError) throw new ValidationError([{ path: 'file', message: 'This image looks damaged and could not be read' }]);
      throw err;
    }
    if (!detected) throw new AppError(415, ERROR_CODES.VALIDATION_FAILED, 'Only images (PNG, JPEG, GIF, WebP), PDF, TXT and CSV files can be attached');

    const entity = { workspaceId: ctx.workspaceId, entityType: info.type, entityId: info.id };
    if ((await attachmentRepository.countForEntity(entity)) >= MAX_ATTACHMENTS_PER_ENTITY) throw full();

    const fileName = displayFileName(q.fileName, detected.mimeType);
    const key = storageKey('attachments', info.type, info.id.toHexString(), `${randomUUID()}-${keySafeName(fileName)}`);
    const contentType = detected.mimeType.startsWith('text/') ? `${detected.mimeType}; charset=utf-8` : detected.mimeType;
    await storage.put(key, body, contentType);

    let doc: IAttachment;
    try {
      doc = await withTransaction(async (session) => {
        // Re-checked in the transaction; the pre-check above only saves a pointless upload.
        if ((await attachmentRepository.countForEntity(entity, session)) >= MAX_ATTACHMENTS_PER_ENTITY) throw full();
        const created = await attachmentRepository.create(
          {
            ...entity,
            projectId: info.projectId,
            uploaderId: ctx.userId,
            storageKey: key,
            fileName,
            mimeType: detected.mimeType,
            sizeBytes: body.length,
            checksumSha256: createHash('sha256').update(body).digest('hex'),
            image: detected.image,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          } as Partial<IAttachment>,
          session,
        );
        await recordActivity(session, {
          workspaceId: ctx.workspaceId,
          projectId: info.projectId,
          entityType: info.type,
          entityId: info.id,
          entityKey: info.key,
          actorId: ctx.userId,
          action: 'attached',
          changes: [{ field: 'file', from: null, to: fileName }],
        });
        return created;
      });
    } catch (err) {
      await removeObject(key);
      throw err;
    }
    return (await toDtos(ctx, info, [doc]))[0]!;
  },

  /** Soft-deletes the record, then removes the object once that has committed. */
  async remove(ctx: AuthContext, id: string): Promise<void> {
    const doc = await attachmentRepository.findById(ctx.workspaceId, id);
    if (!doc) throw new NotFoundError('Attachment');
    let info: EntityInfo;
    try {
      info = await resolveEntity(ctx, doc.entityType, doc.entityId);
    } catch (err) {
      if (err instanceof NotFoundError) throw new NotFoundError('Attachment');
      throw err;
    }
    if (!canRemove(ctx, info, doc.uploaderId)) throw new ForbiddenError('Only the uploader or a project lead can remove this file');

    await withTransaction(async (session) => {
      if (!(await attachmentRepository.softDelete(ctx.workspaceId, doc._id, ctx.userId, session))) throw new NotFoundError('Attachment');
      await recordActivity(session, {
        workspaceId: ctx.workspaceId,
        projectId: info.projectId,
        entityType: info.type,
        entityId: info.id,
        entityKey: info.key,
        actorId: ctx.userId,
        action: 'removed_attachment',
        changes: [{ field: 'file', from: doc.fileName, to: null }],
      });
    });
    await removeObject(doc.storageKey);
  },
};
