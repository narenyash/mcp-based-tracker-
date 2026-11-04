/**
 * Zero-infrastructure dev mode: boots an in-memory MongoDB replica set, migrates, seeds demo
 * data and starts the API. No Docker needed. Data is lost when the process exits.
 * Emails are printed to the log, unless SMTP_PASS and MAIL_REDIRECT_TO are set in apps/server/.env:
 * then they are really sent, all to that one inbox (the demo addresses don't exist).
 */
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

loadDotenv({ path: resolve('.env'), quiet: true });
const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
process.env.MONGO_URI = replSet.getUri('teamtrack');
if (!(process.env.SMTP_PASS && process.env.MAIL_REDIRECT_TO)) process.env.MAIL_TRANSPORT = 'json';
process.env.JWT_ACCESS_SECRET ??= 'dev-only-secret-dev-only-secret-dev-only-secret';

// Import app code only after the environment is set (src/config/env validates at import time).
const { connectDb, disconnectDb } = await import('../src/db/connection');
const { runMigrations } = await import('../src/db/migrator');
const { seedDemo } = await import('./seed');

await connectDb();
await runMigrations();
await seedDemo();
await disconnectDb();

process.on('exit', () => void replSet.stop());
await import('../src/index');
