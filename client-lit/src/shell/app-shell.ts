import { SignalWatcher } from '@lit-labs/signals';
import { Router } from '@vaadin/router';
import { LitElement, css, html } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';

import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/input/input.js';
import type SlInput from '@shoelace-style/shoelace/dist/components/input/input.js';
import '@shoelace-style/shoelace/dist/components/option/option.js';
import '@shoelace-style/shoelace/dist/components/select/select.js';
import type SlSelect from '@shoelace-style/shoelace/dist/components/select/select.js';

import { describeTransport } from '../core/negotiate';
import { controlStyles } from '../panels/shared-styles';
import { currentPath, routes } from '../router';
import { transport, type Preference } from '../store/transport';

/**
 * The frame around every page: masthead, connection controls, readout, nav and
 * the router outlet. Living above the outlet is what keeps Connect and the
 * status pills on screen wherever the router goes — the connection belongs to
 * the app, not to a page.
 */
@customElement('wt-shell')
export class AppShell extends SignalWatcher(LitElement) {
  static override styles = [
    controlStyles,
    css`
      :host {
        display: block;
        max-width: 1120px;
        margin: 0 auto;
        padding: 40px 24px 64px;
      }

      .masthead {
        margin-bottom: 26px;
      }

      .eyebrow {
        display: inline-block;
        font: 500 0.66rem/1 var(--font-data);
        text-transform: uppercase;
        letter-spacing: 0.14em;
        color: var(--ink-2);
      }

      .title {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        align-items: center;
        justify-content: space-between;
        margin: 6px 0 10px;
      }

      h1 {
        margin: 0;
        font: 700 clamp(2rem, 5vw, 2.9rem) / 1 var(--font-display);
        letter-spacing: -0.03em;
      }

      .link {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }

      .link sl-input {
        width: 14ch;
      }

      .link sl-select {
        width: 19ch;
      }

      .pill {
        font: 500 0.68rem/1 var(--font-data);
        text-transform: uppercase;
        letter-spacing: 0.12em;
        padding: 7px 12px;
        border-radius: 999px;
        border: 1px solid var(--rule);
        color: var(--ink-2);
        background: var(--surface);
      }

      .pill.online {
        color: var(--reliable);
        border-color: color-mix(in srgb, var(--reliable) 45%, transparent);
        background: color-mix(in srgb, var(--reliable) 9%, var(--surface));
      }

      .pill.failed {
        color: var(--alert);
        border-color: color-mix(in srgb, var(--alert) 45%, transparent);
        background: color-mix(in srgb, var(--alert) 9%, var(--surface));
      }

      /* The transport pill on the fallback: dashed, the way the ledger draws an
         emulated lane, so the two read as the same claim. */
      .pill.emulated {
        border-style: dashed;
      }

      .detail {
        margin: 0 0 14px;
        color: var(--ink-2);
        font-size: 0.86rem;
      }

      nav {
        display: flex;
        gap: 4px;
        margin: 0 0 14px;
      }

      nav a {
        font: 500 0.74rem/1 var(--font-data);
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--ink-2);
        text-decoration: none;
        padding: 8px 14px;
        border-radius: 999px;
        border: 1px solid transparent;
      }

      nav a:hover {
        color: var(--ink);
        border-color: var(--rule);
      }

      nav a.active {
        color: var(--reliable);
        border-color: color-mix(in srgb, var(--reliable) 45%, transparent);
        background: color-mix(in srgb, var(--reliable) 9%, var(--surface));
      }

      .readout {
        display: grid;
        gap: 12px 26px;
        margin: 0;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        padding-top: 14px;
        border-top: 1px solid var(--rule);
      }

      .readout .wide {
        grid-column: 1 / -1;
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
        font: 400 0.85rem/1.35 var(--font-data);
        overflow-wrap: anywhere;
        font-variant-numeric: tabular-nums;
      }

      .hash {
        font-size: 0.72rem;
        color: var(--ink-2);
        letter-spacing: 0.02em;
      }
    `,
  ];

  @state() private name = suggestName();

  @query('#outlet') private outlet!: HTMLElement;

  private router: Router | null = null;

  /**
   * The strapline stops asserting QUIC when QUIC is not what is underneath.
   * Two guarantees is a WebTransport claim; the fallback has one.
   */
  private eyebrow(): string {
    switch (transport.transport.get()) {
      case 'webtransport':
        return 'QUIC · HTTP/3 · one connection, two guarantees';
      case 'websocket':
        return 'WebSocket · TCP · one connection, one guarantee';
      default:
        return 'QUIC when it gets through, WebSocket when it does not';
    }
  }

  private transportLabel(): string {
    const live = transport.transport.get();
    return live ? describeTransport(live) : 'negotiated at connect time';
  }

  private fingerprint(): string {
    const hex = transport.fingerprint.get();
    if (!hex) {
      return 'fetched from the server at connect time';
    }

    return (hex.match(/.{2}/g) ?? []).join(':');
  }

  override render() {
    const state = transport.state.get();
    const live = transport.transport.get();
    const busy = transport.busy.get();
    const path = currentPath.get();

    return html`
      <header class="masthead">
        <p class="eyebrow">${this.eyebrow()}</p>

        <div class="title">
          <h1>WebTransport console</h1>

          <div class="link">
            <span class="pill ${state}">${state}</span>
            ${
              live
                ? html`
                    <span class="pill ${transport.datagramsEmulated.get() ? 'emulated' : ''}">
                      ${live}
                    </span>
                  `
                : ''
            }
            ${
              transport.online.get()
                ? html`
                    <sl-button class="ghost" @click=${() => transport.disconnect()}>
                      Disconnect
                    </sl-button>
                  `
                : html`
                    <sl-select
                      .value=${transport.preference.get()}
                      ?disabled=${busy}
                      aria-label="Which transport to use"
                      @sl-change=${(event: Event) =>
                        transport.preference.set((event.target as SlSelect).value as Preference)}
                    >
                      <sl-option value="auto">Automatic</sl-option>
                      <sl-option value="webtransport">WebTransport only</sl-option>
                      <sl-option value="websocket">WebSocket only</sl-option>
                    </sl-select>
                    <sl-input
                      .value=${this.name}
                      placeholder="your name"
                      aria-label="Name to use in the room"
                      ?disabled=${busy}
                      @sl-input=${(event: Event) => (this.name = (event.target as SlInput).value)}
                    ></sl-input>
                    <sl-button ?disabled=${busy} @click=${this.connect}>
                      ${busy ? 'Connecting…' : 'Connect'}
                    </sl-button>
                  `
            }
          </div>
        </div>

        <p class="detail">${transport.detail.get()}</p>

        <nav>
          <a href="/" class=${path === '/' ? 'active' : ''}>Console</a>
          <a href="/log" class=${path === '/log' ? 'active' : ''}>Log</a>
          <a href="/about" class=${path === '/about' ? 'active' : ''}>About</a>
        </nav>

        <dl class="readout">
          <div>
            <dt>Transport</dt>
            <dd>${this.transportLabel()}</dd>
          </div>
          <div>
            <dt>Endpoint</dt>
            <dd>${transport.endpoint.get() ?? 'unknown until connect'}</dd>
          </div>
          <div>
            <dt>Session</dt>
            <dd>${transport.sessionId.get() ?? '—'}</dd>
          </div>
          <div class="wide">
            <dt>Certificate sha-256</dt>
            <dd class="hash">${this.fingerprint()}</dd>
          </div>
        </dl>
      </header>

      <main id="outlet"></main>
    `;
  }

  override firstUpdated(): void {
    // The outlet lives in this shadow root; Vaadin Router is fine with that,
    // and its anchor interception still works because clicks are composed.
    this.router = new Router(this.outlet);
    this.router.setRoutes(routes);
  }

  private connect = (): void => {
    void transport.connect(this.name.trim() || 'anonymous');
  };
}

/** Saves the visitor from naming themselves before they can try anything. */
function suggestName(): string {
  const names = ['ash', 'birch', 'cedar', 'elm', 'fir', 'hazel', 'linden', 'rowan'];
  return names[Math.floor(Math.random() * names.length)];
}

declare global {
  interface HTMLElementTagNameMap {
    'wt-shell': AppShell;
  }
}
