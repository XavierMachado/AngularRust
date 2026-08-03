import { SignalWatcher } from '@lit-labs/signals';
import { LitElement, css, html, svg } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import { transport } from '../store/transport';
import { controlStyles, panelStyles } from './shared-styles';

/** Ping and pong over datagrams. The unreliable path. */
@customElement('wt-datagram-panel')
export class DatagramPanel extends SignalWatcher(LitElement) {
  static override styles = [
    panelStyles,
    controlStyles,
    css`
      .row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 14px;
      }

      .stats {
        display: flex;
        gap: 26px;
        margin: 0 0 12px;
        flex-wrap: wrap;
      }

      .stats div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      dt {
        font: 500 0.65rem/1 var(--font-data);
        text-transform: uppercase;
        letter-spacing: 0.11em;
        color: var(--ink-2);
      }

      dd {
        margin: 0;
        font: 500 1.15rem/1 var(--font-data);
        color: var(--unreliable);
        font-variant-numeric: tabular-nums;
      }

      svg {
        display: block;
        width: 100%;
        height: 60px;
        background: var(--paper);
        border-radius: 8px;
      }

      polyline {
        fill: none;
        stroke: var(--unreliable);
        stroke-width: 1.5;
        vector-effect: non-scaling-stroke;
        stroke-linejoin: round;
      }

      .scale {
        margin: 6px 0 0;
        font: 400 0.7rem/1.4 var(--font-data);
        color: var(--ink-2);
      }

      header {
        display: flex;
        align-items: baseline;
        gap: 10px;
        flex-wrap: wrap;
      }

      header h2 {
        margin-right: auto;
      }

      .badge {
        font: 500 0.62rem/1 var(--font-data);
        text-transform: uppercase;
        letter-spacing: 0.11em;
        padding: 5px 9px;
        border-radius: 999px;
        border: 1px dashed color-mix(in srgb, var(--unreliable) 55%, transparent);
        color: var(--unreliable);
      }

      /* Dashed, matching the ledger's emulated lane and the masthead pill. */
      .panel.emulated {
        border-style: dashed;
      }

      .muted {
        color: var(--ink-2);
      }
    `,
  ];

  @state() private running = false;

  private timer: ReturnType<typeof setInterval> | undefined;

  override disconnectedCallback(): void {
    // Leaving the page stops the auto-ping; the store's RTT history survives.
    clearInterval(this.timer);
    this.running = false;
    super.disconnectedCallback();
  }

  private ceiling(): number {
    const samples = transport.rtt.get();
    const peak = samples.reduce((high, sample) => Math.max(high, sample.ms), 1);
    return Math.ceil(peak);
  }

  private path(): string {
    const samples = transport.rtt.get().slice(-60);
    if (!samples.length) {
      return '';
    }

    const top = this.ceiling();
    const step = samples.length > 1 ? 300 / (samples.length - 1) : 0;

    return samples
      .map((sample, index) => {
        const y = 58 - (sample.ms / top) * 52;
        return `${(index * step).toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }

  override render() {
    const emulated = transport.datagramsEmulated.get();
    const path = this.path();

    return html`
      <section class="panel unreliable ${emulated ? 'emulated' : ''}">
        <header>
          <span class="eyebrow">Datagrams</span>
          <h2>Round trip</h2>
          ${emulated ? html`<span class="badge">emulated</span>` : ''}
        </header>

        ${
          emulated
            ? html`
                <p class="lede">
                  This connection has no datagram channel. Ping and pong here ride the same ordered,
                  reliable socket as everything else: nothing will be lost, nothing reordered, and
                  Unanswered should stay at zero. What the chart measures is queueing delay behind
                  whatever else is on the socket — a real number, about a different thing.
                </p>
              `
            : html`
                <p class="lede">
                  Datagrams skip retransmission and ordering entirely. A missing pong is the
                  transport working as designed, not a bug.
                </p>
              `
        }

        <div class="row">
          <button ?disabled=${!transport.online.get()} @click=${this.once}>Send one</button>
          <button
            class="ghost"
            ?disabled=${!transport.online.get() && !this.running}
            @click=${this.toggle}
          >
            ${this.running ? 'Stop' : 'Send twice a second'}
          </button>
        </div>

        <dl class="stats">
          <div>
            <dt>Last</dt>
            <dd>${this.show(transport.lastRtt.get())}</dd>
          </div>
          <div>
            <dt>Median</dt>
            <dd>${this.show(transport.medianRtt.get())}</dd>
          </div>
          <div>
            <dt>Unanswered</dt>
            ${
              emulated
                ? html`
                    <dd
                      class="muted"
                      title="A reliable channel cannot lose one, so this cannot be news."
                    >
                      n/a
                    </dd>
                  `
                : html`<dd>${transport.lostDatagrams.get()}</dd>`
            }
          </div>
        </dl>

        ${
          path.length
            ? html`
                ${svg`
                <svg viewBox="0 0 300 60" preserveAspectRatio="none" role="img" aria-label="Round trip times">
                  <polyline points=${path} />
                </svg>
              `}
                <p class="scale">0 to ${this.ceiling()} ms, most recent on the right</p>
              `
            : html`<p class="scale">No samples yet.</p>`
        }
      </section>
    `;
  }

  private show(value: number | null): string {
    return value === null ? '—' : `${value.toFixed(1)} ms`;
  }

  private once = async (): Promise<void> => {
    await transport.ping().catch(() => undefined);
  };

  private toggle = (): void => {
    if (this.running) {
      clearInterval(this.timer);
      this.running = false;
      return;
    }

    this.running = true;
    this.timer = setInterval(() => {
      if (!transport.online.get()) {
        clearInterval(this.timer);
        this.running = false;
        return;
      }

      void transport.ping().catch(() => undefined);
    }, 500);
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'wt-datagram-panel': DatagramPanel;
  }
}
