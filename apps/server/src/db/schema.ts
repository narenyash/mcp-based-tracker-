import { collectionName } from '../config/env';
import { Schema, type MongooseQueryMiddleware, type Query, type SchemaDefinition } from 'mongoose';

const QUERY_HOOKS: MongooseQueryMiddleware[] = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'countDocuments',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'distinct',
];

const HIDDEN_FIELDS = ['_id', 'passwordHash', 'tokenHash', 'deletedAt', 'deletedBy', 'schemaVersion'];

export interface SchemaOptions {
  collection: string;
  /** Adds deletedAt/deletedBy and hides deleted docs from queries unless `{ withDeleted: true }`. */
  softDelete?: boolean;
  /** Rejects any query whose filter has no workspaceId unless `{ skipTenant: true }`. */
  tenant?: boolean;
  timestamps?: boolean;
  /** Audit fields (createdBy/updatedBy). Off for system collections. */
  audit?: boolean;
}

/**
 * Single factory for every schema so that cross-cutting rules (versioning, strictness,
 * soft delete, tenant isolation, JSON shape) cannot be forgotten on a new model.
 */
export function createSchema<T>(definition: SchemaDefinition, opts: SchemaOptions): Schema<T> {
  const schema = new Schema<T>(definition as SchemaDefinition<T>, {
    collection: collectionName(opts.collection),
    timestamps: opts.timestamps ?? true,
    versionKey: 'version',
    optimisticConcurrency: true,
    strict: 'throw',
    strictQuery: true,
    id: false,
    toJSON: {
      virtuals: false,
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        for (const f of HIDDEN_FIELDS) Reflect.deleteProperty(ret, f);
        return ret;
      },
    },
  });

  // Untyped view for adding cross-cutting paths that are not part of T's declared shape.
  const base = schema as unknown as Schema;
  base.add({ schemaVersion: { type: Number, default: 1 } });

  if (opts.audit ?? true) {
    base.add({
      createdBy: { type: Schema.Types.ObjectId, default: null },
      updatedBy: { type: Schema.Types.ObjectId, default: null },
    });
  }

  if (opts.softDelete) {
    base.add({
      deletedAt: { type: Date, default: null },
      deletedBy: { type: Schema.Types.ObjectId, default: null },
    });
    schema.pre(QUERY_HOOKS, function (this: Query<unknown, unknown>) {
      if (this.getOptions().withDeleted) return;
      if (!('deletedAt' in this.getFilter())) this.where({ deletedAt: null });
    });
    schema.pre('aggregate', function () {
      if ((this.options as { withDeleted?: boolean }).withDeleted) return;
      this.pipeline().unshift({ $match: { deletedAt: null } });
    });
  }

  if (opts.tenant) {
    schema.pre(QUERY_HOOKS, function (this: Query<unknown, unknown>) {
      if (this.getOptions().skipTenant) return;
      if (!('workspaceId' in this.getFilter())) {
        throw new Error(`Tenant guard: ${opts.collection}.${(this as unknown as { op?: string }).op ?? 'query'} without workspaceId`);
      }
    });
    schema.pre('aggregate', function () {
      if ((this.options as { skipTenant?: boolean }).skipTenant) return;
      const first = this.pipeline().find((s) => '$match' in s) as { $match?: object } | undefined;
      if (!first?.$match || !('workspaceId' in first.$match)) {
        throw new Error(`Tenant guard: ${opts.collection}.aggregate without workspaceId $match`);
      }
    });
  }

  return schema;
}

/** Collation for case-insensitive unique indexes (emails, keys, names). */
export const CI_COLLATION = { locale: 'en', strength: 2 } as const;
export const NOT_DELETED = { deletedAt: null } as const;
