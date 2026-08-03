import { SignalWatcher } from '@lit-labs/signals';
import { LitElement, css, html } from 'lit';
import { customElement } from 'lit/decorators.js';

import { humanBytes } from '../core/wasm';
import { transport } from '../store/transport';
import '../panels/datagram-panel';
import '../panels/request-panel';
import '../panels/room-panel';
import '../panels/stream-ledger';
import '../panels/upload-panel';

/** The landing page: the ledger, the telemetry strip and the four lane panels. */
@customElement('wt-console-page')
export class ConsolePage extends SignalWatcher(LitElement) {
  static override styles = css`
    :host {
      display: block;
    }

    .telemetry {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
      gap: 12px 26px;
      margin: 18px 0 22px;
    }

    dt {
      font: 500 0.64rem/1 var(--font-data);
      text-transform: uppercase;
      letter-spacing: 0.11em;
      color: var(--ink-2);
      margin-bottom: 4px;
    }

    dd {
      margin: 0;
      font: 500 1.1rem/1.35 var(--font-data);
      overflow-wrap: anywhere;
      font-variant-numeric: tabular-nums;
    }

    .split {
      display: block;
      margin-top: 2px;
      font-size: 0.72rem;
      font-weight: 400;
      color: var(--ink-2);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(330px, 1fr));
      gap: 18px;
      margin: 22px 0;
    }

    footer {
      margin-top: 30px;
      padding-top: 16px;
      border-top: 1px solid var(--rule);
    }

    footer p {
      margin: 0;
      max-width: 62ch;
      font-size: 0.78rem;
      line-height: 1.6;
      color: var(--ink-2);
    }
  `;

  private uptime(): string {
    const stats = transport.telemetry.get();
    if (!stats) {
      return '—';
    }

    const minutes = Math.floor(stats.uptimeSecs / 60);
    const seconds = stats.uptimeSecs % 60;

    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }

  override render() {
    const stats = transport.telemetry.get();

    return html`
      <wt-stream-ledger></wt-stream-ledger>

      ${
        stats
          ? html`
              <dl class="telemetry">
                <div>
                  <dt>Sessions</dt>
                  <dd>
                    ${stats.sessions}
                    <span class="split"
                      >${stats.sessionsWebtransport} wt / ${stats.sessionsWebsocket} ws</span
                    >
                  </dd>
                </div>
                <div>
                  <dt>Frames in</dt>
                  <dd>${stats.framesIn}</dd>
                </div>
                <div>
                  <dt>Datagrams in</dt>
                  <dd>${stats.datagramsIn}</dd>
                </div>
                <div>
                  <dt>Bytes in</dt>
                  <dd>${humanBytes(stats.bytesIn)}</dd>
                </div>
                <div>
                  <dt>Server uptime</dt>
                  <dd>${this.uptime()}</dd>
                </div>
              </dl>
            `
          : ''
      }

      <div class="grid">
        <wt-request-panel></wt-request-panel>
        <wt-datagram-panel></wt-datagram-panel>
        <wt-room-panel></wt-room-panel>
        <wt-upload-panel></wt-upload-panel>
      </div>

      <footer>
        <p>
          The certificate is generated fresh on every server start and trusted by fingerprint, which
          is a development shortcut. In production the server holds a normal CA-issued certificate
          and the client passes no hashes at all. The WebSocket fallback needs none of it: it rides
          the same TLS chain the page itself does.
        </p>
      </footer>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'wt-console-page': ConsolePage;
  }
}
