import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // `npm test` must never depend on network access and must never broadcast.
    // Local-Anvil integration coverage is exercised by `npm run demo:local`,
    // not by vitest.
    reporters: ['default'],
  },
});
