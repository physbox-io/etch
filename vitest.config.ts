import { defineConfig } from 'vitest/config';

// Unit tests for the pure geometry logic in src/utils. The SVG importer needs a
// DOMParser, so those tests run in jsdom; everything else is plain maths.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
  },
});
