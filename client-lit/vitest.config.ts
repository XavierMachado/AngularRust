import { defineConfig } from 'vitest/config';

/**
 * Covers the plain TypeScript in `core/`: framing, protocol shapes, the
 * negotiation table, the WebSocket link and the signals store. None of it
 * needs a DOM — the same policy the Angular client follows.
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
