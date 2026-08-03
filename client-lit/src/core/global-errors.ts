import type { TransportStore } from '../store/transport';

/**
 * Sends uncaught errors to the console log panel as well as the browser
 * console.
 *
 * Listening on `error` and `unhandledrejection` catches what Angular's
 * `provideBrowserGlobalErrorListeners` catches: a stream read that rejects
 * inside a `void`-ed async call has nowhere else to go. Keeping them on the
 * same timeline as the server's own log records is the point of the panel.
 */
export function installGlobalErrorHooks(transport: TransportStore): void {
  const report = (error: unknown): void => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);

    transport.note('app', message.split('\n').slice(0, 3).join(' · '), 'error');
    console.error(error);
  };

  window.addEventListener('error', (event) => report(event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => report(event.reason));
}
