import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so tests run from the repo root without the dev API plugin.
export default defineConfig({ test: { include: ['test/**/*.test.js'], environment: 'node' } });
