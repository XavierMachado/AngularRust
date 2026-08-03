import { SignalWatcher } from '@lit-labs/signals';
import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/input/input.js';
import type SlInput from '@shoelace-style/shoelace/dist/components/input/input.js';

import type { Reply, Request } from '../core/protocol';
import { fibLocal } from '../core/wasm';
import { transport } from '../store/transport';
import { controlStyles, panelStyles } from './shared-styles';

/** One request, one reply, one stream. The reliable path. */
@customElement('wt-request-panel')
export class RequestPanel extends SignalWatcher(LitElement) {
  static override styles = [
    panelStyles,
    controlStyles,
    css`
      .row {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        margin-bottom: 10px;
      }

      .row label {
        font: 500 0.7rem/1 var(--font-data);
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--ink-2);
      }

      sl-input.text {
        flex: 1 1 12ch;
        min-width: 0;
      }

      sl-input.number {
        width: 9ch;
      }

      output {
        display: block;
        margin-top: 4px;
        padding: 12px 14px;
        border-radius: 10px;
        background: var(--paper);
        font: 400 0.8rem/1.5 var(--font-data);
        min-height: 2.6em;
        overflow-wrap: anywhere;
      }

      .empty,
      .waiting {
        color: var(--ink-2);
      }

      .waiting::after {
        content: '…';
        animation: blink 1.1s steps(1) infinite;
      }

      @keyframes blink {
        50% {
          opacity: 0.25;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .waiting::after {
          animation: none;
        }
      }
    `,
  ];

  @state() private text = 'the quick brown fox';
  @state() private n = 90;
  @state() private result = '';
  @state() private inFlight: string | null = null;

  private get idle(): boolean {
    return !transport.online.get() || this.inFlight !== null;
  }

  override render() {
    return html`
      <section class="panel reliable">
        <header>
          <span class="eyebrow">Bidirectional stream</span>
          <h2>Ask the server</h2>
        </header>

        <p class="lede">
          Each request opens its own stream and closes it when the reply lands. Send a slow one and
          a fast one together to watch them overtake each other. The Fibonacci row can also run the
          same Rust right here through wasm — no server involved.
        </p>

        <div class="row">
          <sl-input
            class="text"
            size="medium"
            .value=${this.text}
            ?disabled=${!transport.online.get()}
            placeholder="anything at all"
            label=""
            aria-label="Text to send"
            @sl-input=${(event: Event) => (this.text = (event.target as SlInput).value)}
          ></sl-input>
          <sl-button
            ?disabled=${this.idle}
            @click=${() => this.send({ op: 'echo', text: this.text })}
          >
            Echo
          </sl-button>
          <sl-button
            ?disabled=${this.idle}
            @click=${() => this.send({ op: 'reverse', text: this.text })}
          >
            Reverse
          </sl-button>
        </div>

        <div class="row">
          <label for="fib">Fibonacci</label>
          <sl-input
            id="fib"
            class="number"
            type="number"
            min="0"
            max="185"
            .value=${String(this.n)}
            aria-label="Fibonacci index"
            @sl-input=${(event: Event) => (this.n = Number((event.target as SlInput).value) || 0)}
          ></sl-input>
          <sl-button ?disabled=${this.idle} @click=${() => this.send({ op: 'fib', n: this.n })}>
            On the server
          </sl-button>
          <sl-button @click=${this.fibHere}>In this tab</sl-button>
          <sl-button class="ghost" ?disabled=${this.idle} @click=${() => this.send({ op: 'ping' })}>
            Ping
          </sl-button>
        </div>

        <output>
          ${
            this.inFlight
              ? html`<span class="waiting">Waiting for ${this.inFlight} reply</span>`
              : this.result
                ? html`<code>${this.result}</code>`
                : html`<span class="empty">No reply yet.</span>`
          }
        </output>
      </section>
    `;
  }

  private async send(request: Request): Promise<void> {
    this.inFlight = request.op;
    this.result = '';

    const started = performance.now();

    try {
      const reply = await transport.request(request);
      const elapsed = Math.round((performance.now() - started) * 10) / 10;
      this.result = `${render(reply)}   ·   ${elapsed} ms round trip`;
    } catch (error) {
      this.result = error instanceof Error ? error.message : String(error);
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * The identical `wt_shared::compute::fib`, but through wasm instead of a
   * round trip — which is why it works with the connection down, and why the
   * value always matches what "On the server" returns.
   */
  private fibHere = (): void => {
    const started = performance.now();

    try {
      const value = fibLocal(this.n);
      const micros = Math.max(1, Math.round((performance.now() - started) * 1000));
      this.result = `fib(${this.n}) = ${value}   ·   ${micros} µs in this tab, via wasm`;
    } catch (error) {
      this.result = error instanceof Error ? error.message : String(error);
    }
  };
}

function render(reply: Reply): string {
  switch (reply.op) {
    case 'pong':
      return `server clock ${new Date(reply.serverTimeMs).toLocaleTimeString()}`;
    case 'echo':
      return reply.text;
    case 'reversed':
      return reply.text;
    case 'fib':
      return `fib(${reply.n}) = ${reply.value}   ·   ${reply.tookMicros} µs on the server`;
    case 'accepted':
      return 'accepted';
    case 'error':
      return reply.message;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'wt-request-panel': RequestPanel;
  }
}
