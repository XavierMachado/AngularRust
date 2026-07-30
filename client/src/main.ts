import { bootstrapApplication } from '@angular/platform-browser';
import initWasm from 'wt-wasm';

import { App } from './app/app';
import { appConfig } from './app/app.config';

/**
 * The wasm module loads before Angular boots, so every call into it after
 * this point is synchronous. The .wasm file is copied into the app root by
 * the assets config in angular.json.
 */
initWasm({ module_or_path: 'wt_wasm_bg.wasm' })
  .then(() => bootstrapApplication(App, appConfig))
  .catch((error: unknown) => {
    console.error('Failed to start the console', error);
  });
