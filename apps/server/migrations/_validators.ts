import type { mongo } from 'mongoose';
import { collectionName } from '../src/config/env';

/** $jsonSchema building blocks shared by migrations (0001 predates this file and inlines its own). */
export const oid = { bsonType: 'objectId' };
export const oidOrNull = { bsonType: ['objectId', 'null'] };
export const str = (maxLength?: number) => ({ bsonType: 'string', ...(maxLength ? { maxLength } : {}) });
export const date = { bsonType: 'date' };
export const dateOrNull = { bsonType: ['date', 'null'] };
export const num = { bsonType: ['int', 'long', 'double', 'decimal'] };
export const bool = { bsonType: 'bool' };
export const enumOf = (values: readonly string[]) => ({ enum: values });

export function jsonSchema(required: string[], properties: Record<string, mongo.Document>): mongo.Document {
  return { $jsonSchema: { bsonType: 'object', required, properties } };
}

/** Creates each collection with its validator, or updates the validator if it already exists. */
export async function applyValidators(db: mongo.Db, validators: Record<string, mongo.Document>): Promise<void> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const [logical, validator] of Object.entries(validators)) {
    const name = collectionName(logical);
    const opts = { validator, validationLevel: 'strict', validationAction: 'error' } as const;
    if (existing.has(name)) await db.command({ collMod: name, ...opts });
    else await db.createCollection(name, opts);
  }
}
