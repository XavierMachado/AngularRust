/**
 * The framing facade delegates to the compiled wasm, so the tests need the
 * module instantiated first. In the browser `main.ts` fetches it; under Node
 * the bytes come straight off disk — which means vitest exercises the real
 * binary the app ships, not a mock of it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync } from 'wt-wasm';

const wasmPath = fileURLToPath(new URL('../wasm/pkg/wt_wasm_bg.wasm', import.meta.url));

initSync({ module: readFileSync(wasmPath) });
