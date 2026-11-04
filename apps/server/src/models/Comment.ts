import { model, Schema, type Types } from 'mongoose';
import { ENTITY_TYPES, MAX_COMMENT_LENGTH, MAX_MENTIONS, type EntityType } from '@teamtrack/shared';
import { createSchema } from '../db/schema';

/** A comment on any entity. Replies are one level deep; deleted comments with replies stay as a placeholder. */
export interface IComment {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId | null;
  entityType: EntityType;
  entityId: Types.ObjectId;
  parentId: Types.ObjectId | null;
  authorId: Types.ObjectId;
  /** Plain text; mentions inline as `@[Name](userId)` tokens, validated server-side. */
  body: string;
  mentionUserIds: Types.ObjectId[];
  /** Live replies (top-level comments only); keeps a deleted parent visible while it has any. */
  replyCount: number;
  editedAt: Date | null;
  deletedAt: Date | null;
  deletedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const schema = createSchema<IComment>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    projectId: { type: Schema.Types.ObjectId, default: null, immutable: true },
    entityType: { type: String, enum: ENTITY_TYPES, required: true, immutable: true },
    entityId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    parentId: { type: Schema.Types.ObjectId, default: null, immutable: true },
    authorId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    body: { type: String, required: true, maxlength: MAX_COMMENT_LENGTH },
    mentionUserIds: {
      type: [Schema.Types.ObjectId],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= MAX_MENTIONS, message: `At most ${MAX_MENTIONS} mentions` },
    },
    replyCount: { type: Number, default: 0, min: 0 },
    editedAt: { type: Date, default: null },
  },
  { collection: 'comments', softDelete: true, tenant: true },
);

// A thread, oldest first, keyset-paginated (deleted placeholders included, so no partial filter).
schema.index({ workspaceId: 1, entityType: 1, entityId: 1, createdAt: 1, _id: 1 });

export const Comment = model<IComment>('Comment', schema);
