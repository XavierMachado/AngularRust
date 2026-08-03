import './styles.css';

import initWasm from 'wt-wasm';
import wasmUrl from 'wt-wasm/wt_wasm_bg.wasm?url';

// The wasm module loads before anything renders, so every later call into it —
// framing, validation, formatting — can be synchronous. Everything that could
// touch wasm sits behind the dynamic imports below, exactly the guarantee the
// Angular client gets by initialising wasm before bootstrapping.
await initWasm({ module_or_path: wasmUrl });

const [{ transport }, { installGlobalErrorHooks }] = await Promise.all([
  import('./store/transport'),
  import('./core/global-errors'),
]);

installGlobalErrorHooks(transport);

await import('./shell/app-shell');
