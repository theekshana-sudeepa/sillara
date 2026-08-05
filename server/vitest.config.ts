import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    setupFiles: ['./tests/setup-env.ts'],
    // Integration tests share one MySQL database. Running files in parallel
    // would have them fighting over the same rows, so files run one at a time.
    // The unit tests are a few milliseconds each; nothing is lost.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
