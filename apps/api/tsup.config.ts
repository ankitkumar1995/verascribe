import { cp } from 'node:fs/promises';
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: {
    server: 'src/server.ts',
    migrate: 'scripts/migrate.ts',
    doctor: 'scripts/doctor.ts',
  },
  format: ['esm'],
  target: 'node24',
  noExternal: ['@verascribe/contracts'],
  clean: true,
  onSuccess: async () => {
    await cp('src/db/migrations', 'dist/migrations', { recursive: true });
  },
});
