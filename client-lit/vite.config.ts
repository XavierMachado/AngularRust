import { defineConfig } from 'vite';

export default defineConfig({
  // 4200 belongs to the Angular dev server; both consoles run side by side
  // against the one wt-server on 4433.
  server: { port: 5273 },
  build: { target: 'es2022' },
  // wt-wasm is a local ESM package; pre-bundling it would break the
  // `wt_wasm_bg.wasm?url` subpath import in dev.
  optimizeDeps: { exclude: ['wt-wasm'] },
});
