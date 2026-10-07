import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 120_000,
    // Transforms dominate run time on this Windows host, so persist them across runs.
    fsModuleCache: true,
  },
});
