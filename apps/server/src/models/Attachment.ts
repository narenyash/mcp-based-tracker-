import { model, Schema, type Types } from 'mongoose';
import { ATTACHMENT_MIME_TYPES, ENTITY_TYPES, MAX_ATTACHMENT_BYTES, MAX_FILE_NAME_LENGTH, type AttachmentMimeType, type EntityType } from '@teamtrack/shared';
import { createSchema } from '../db/schema';

/** A file stored in object storage and attached to an entity. The bytes live under `storageKey`. */
export interface IAttachment {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId | null;
  entityType: EntityType;
  entityId: Types.ObjectId;
  uploaderId: Types.ObjectId;
  storageKey: string;
  fileName: string;
  mimeType: AttachmentMimeType;
  sizeBytes: number;
  checksumSha256: string;
  image: { width: number; height: number } | null;
  deletedAt: Date | null;
  deletedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const imageSize = new Schema(
  { width: { type: Number, required: true, min: 1 }, height: { type: Number, required: true, min: 1 } },
  { _id: false, strict: 'throw' },
);

const schema = createSchema<IAttachment>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    projectId: { type: Schema.Types.ObjectId, default: null, immutable: true },
    entityType: { type: String, enum: ENTITY_TYPES, required: true, immutable: true },
    entityId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    uploaderId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    storageKey: { type: String, required: true, immutable: true, maxlength: 600 },
    fileName: { type: String, required: true, maxlength: MAX_FILE_NAME_LENGTH },
    mimeType: { type: String, enum: ATTACHMENT_MIME_TYPES, required: true, immutable: true },
    sizeBytes: { type: Number, required: true, min: 1, max: MAX_ATTACHMENT_BYTES, immutable: true },
    checksumSha256: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
    image: { type: imageSize, default: null },
  },
  { collection: 'attachments', softDelete: true, tenant: true },
);

// An entity's files, in upload order (and the per-entity count).
schema.index({ workspaceId: 1, entityType: 1, entityId: 1, createdAt: 1 });

export const Attachment = model<IAttachment>('Attachment', schema);
