/** Read-only connectivity check: pings the configured database and reports TeamTrack's footprint. Writes nothing. */
import mongoose from 'mongoose';
import { env } from '../src/config/env';

const conn = await mongoose.connect(env.mongo.uri, { ...(env.mongo.dbName ? { dbName: env.mongo.dbName } : {}), serverSelectionTimeoutMS: 15_000 });
const db = conn.connection.db!;
await db.admin().ping();
const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
const ours = names.filter((n) => n.startsWith(env.COLLECTION_PREFIX));
const hello = (await db.admin().command({ hello: 1 })) as { setName?: string };
console.log(JSON.stringify({
  database: db.databaseName,
  replicaSet: hello.setName ?? null,
  totalCollections: names.length,
  teamtrackCollections: ours,
}, null, 2));
await mongoose.disconnect();
