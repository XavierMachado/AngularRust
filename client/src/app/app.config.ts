import {
  ApplicationConfig,
  ErrorHandler,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { ConsoleErrorHandler } from './core/error-handler';

/**
 * Zoneless on purpose. Everything here arrives through stream readers and
 * promise chains that zone.js does not reliably patch; signals notify Angular
 * directly, so the UI tracks the connection without a zone in the middle.
 *
 * On Angular 18 or 19 this is `provideExperimentalZonelessChangeDetection` and
 * zone.js has to be dropped from the build separately.
 *
 * `provideBrowserGlobalErrorListeners` routes uncaught errors and unhandled
 * promise rejections to the `ErrorHandler`, which puts them in the log panel
 * alongside the server's own records.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes),
    { provide: ErrorHandler, useClass: ConsoleErrorHandler },
  ],
};
