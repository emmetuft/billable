import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Fixed zone with DST transitions so time-boundary tests are deterministic.
    env: { TZ: 'America/New_York' },
  },
});
