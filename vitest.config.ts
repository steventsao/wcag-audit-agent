import { defineConfig } from 'vitest/config';

// The unit tests cover the pure, framework-free core (no `cloudflare:workers` import), so they run in
// a plain node environment. Run: `npm test`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
