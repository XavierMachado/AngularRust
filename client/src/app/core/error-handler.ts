import { ErrorHandler, inject, Injectable } from '@angular/core';

import { TransportService } from './transport.service';

/**
 * Sends uncaught errors to the console log panel as well as the browser
 * console.
 *
 * Paired with `provideBrowserGlobalErrorListeners`, this catches unhandled
 * promise rejections too, which is where transport failures usually surface:
 * a stream read that rejects inside a `void`-ed async call has nowhere else to
 * go. Keeping them on the same timeline as the server's own log records is the
 * point of the panel.
 */
@Injectable()
export class ConsoleErrorHandler implements ErrorHandler {
  private readonly transport = inject(TransportService);

  handleError(error: unknown): void {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);

    this.transport.note('app', message.split('\n').slice(0, 3).join(' · '), 'error');
    console.error(error);
  }
}
