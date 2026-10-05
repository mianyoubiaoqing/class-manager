import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Large SQLite backup fixtures must not compete with other test files for memory and disk.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
