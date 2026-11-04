import { inject } from 'vitest';

// Must run before any src module is imported (src/config/env validates process.env at import time).
Object.assign(process.env, {
  NODE_ENV: 'test',
  MONGO_URI: inject('mongoUri'),
  JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-0123456789',
  JWT_ACCESS_KID: 'test',
  CLIENT_URL: 'http://localhost:5173',
  MAIL_TRANSPORT: 'json',
  RATE_LIMIT_ENABLED: 'false',
  ALLOW_WORKSPACE_SIGNUP: 'true',
});
