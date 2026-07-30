import { defineConfig } from 'vitest/config';

/**
 * Covers the plain TypeScript in `core/`: framing, protocol shapes, anything
 * with no Angular or browser dependency. That is deliberately where the logic
 * that can be wrong in a subtle way lives.
 *
 * Component tests need a DOM and Angular's test harness; add
 * `@angular/build:unit-test` to angular.json when you want them.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    reporters: ['default'],
    // Instantiates the wasm module the framing facade delegates to.
    setupFiles: ['vitest.setup.ts'],
  },
});
