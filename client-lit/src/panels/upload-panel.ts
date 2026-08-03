import { SignalWatcher } from '@lit-labs/signals';
import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import { transport } from '../store/transport';
import { controlStyles, panelStyles } from './shared-styles';

/** Bytes one way, no reply. The shape of a file upload. */
@customElement('wt-upload-panel')
export class UploadPanel extends SignalWatcher(LitElement) {
  static override styles = [
    panelStyles,
    controlStyles,
    css`
      .row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }

      .status {
        margin: 0;
        font: 400 0.78rem/1.5 var(--font-data);
        color: var(--ink-2);
      }

      .status.working {
        color: var(--reliable);
      }
    `,
  ];

  private readonly sizes = [256, 2048, 16384];

  @state() private busy = false;
  @state() private status = 'Idle.';

  override render() {
    // "Emulated datagrams" doubles as "is this the WebSocket", because the two
    // differences that matter here — a lane instead of a stream, polled instead
    // of awaited backpressure — arrive together.
    const emulated = transport.datagramsEmulated.get();

    return html`
      <section class="panel reliable">
        <header>
          <span class="eyebrow">${emulated ? 'Upload lane' : 'Unidirectional stream'}</span>
          <h2>Send bulk</h2>
        </header>

        ${
          emulated
            ? html`
                <p class="lede">
                  Writes 16 KiB at a time on the socket's own upload lane — raw bytes, not base64 —
                  and waits when <code>bufferedAmount</code> says the send buffer is full. That is a
                  number you poll rather than a promise you await, which is the closest a WebSocket
                  gets to a stream's flow control. The server reads to the end, times it, and
                  announces the rate to every session.
                </p>
              `
            : html`
                <p class="lede">
                  Writes 16 KiB at a time and waits when the stream's flow control says wait. The
                  server reads to the end, times it, and announces the rate to every session.
                </p>
              `
        }

        <div class="row">
          ${this.sizes.map(
            (size) => html`
              <button
                ?disabled=${this.busy || !transport.online.get()}
                @click=${() => this.send(size)}
              >
                ${this.label(size)}
              </button>
            `,
          )}
        </div>

        <p class="status ${this.busy ? 'working' : ''}">${this.status}</p>
      </section>
    `;
  }

  private label(kibibytes: number): string {
    return kibibytes >= 1024 ? `${kibibytes / 1024} MiB` : `${kibibytes} KiB`;
  }

  private async send(kibibytes: number): Promise<void> {
    this.busy = true;
    this.status = `Sending ${this.label(kibibytes)}…`;

    const started = performance.now();

    try {
      await transport.upload(kibibytes);

      const seconds = (performance.now() - started) / 1000;
      const rate = kibibytes / 1024 / Math.max(seconds, 0.001);
      this.status =
        `Sent ${this.label(kibibytes)} in ${(seconds * 1000).toFixed(0)} ms, ` +
        `${rate.toFixed(1)} MiB/s as measured here.`;
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'wt-upload-panel': UploadPanel;
  }
}
