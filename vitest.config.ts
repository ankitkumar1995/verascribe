import { defineConfig } from 'vitest/config';
// Model runtimes and parser subprocesses are CPU/memory intensive.
export default defineConfig({ test: { maxWorkers: 4 } });
