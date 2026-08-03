import { LitElement, css, html } from 'lit';
import { customElement } from 'lit/decorators.js';

import '../panels/event-log';

/**
 * The event log with the whole viewport to itself. The store keeps collecting
 * whether or not this page is mounted, so arriving here shows everything that
 * happened while the console page had the screen.
 */
@customElement('wt-log-page')
export class LogPage extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }

    wt-event-log {
      --log-height: max(340px, calc(100vh - 420px));
    }
  `;

  override render() {
    return html`<wt-event-log></wt-event-log>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'wt-log-page': LogPage;
  }
}
