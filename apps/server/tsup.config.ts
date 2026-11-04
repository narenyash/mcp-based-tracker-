import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'scripts/migrate.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // Bundle the shared workspace package (it ships TypeScript source); keep real deps external.
  noExternal: ['@teamtrack/shared'],
});
