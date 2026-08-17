import { defineConfig } from 'vitest/config'

/**
 * Shared test defaults.
 *
 * Timeouts are generous because a meaningful test in this codebase opens a
 * Corestore, joins a swarm, and waits for a second peer. A 5s default would
 * make real tests flaky and push people towards mocks that prove nothing.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts']
    }
  }
})
