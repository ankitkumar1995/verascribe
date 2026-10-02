import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node24',
  noExternal: ['@verascribe/contracts'],
  clean: true,
});
