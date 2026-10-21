import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Every test file shares one Postgres database.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 120000
  }
})
