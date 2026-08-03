import { SignalWatcher } from '@lit-labs/signals';
import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import { validateSay } from '../core/wasm';
import { transport } from '../store/transport';
import { fmtTime } from './format';
import { controlStyles, panelStyles } from './shared-styles';

/**
 * Send on a bidirectional stream, receive on the server's push stream. Open a
 * second browser tab — or the Angular console — to see the fan-out.
 */
@customElement('wt-room-panel')
export class RoomPanel extends SignalWatcher(LitElement) {
  static override styles = [
    panelStyles,
    controlStyles,
    css`
      .lines {
        list-style: none;
        margin: 0 0 12px;
        height: 190px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 6px;
        background: var(--paper);
        border-radius: 10px;
        padding: 12px;
      }

      li {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 8px;
        align-items: baseline;
        font-size: 0.84rem;
        line-height: 1.45;
      }

      .who {
        font: 500 0.72rem/1.6 var(--font-data);
        color: var(--reliable);
        white-space: nowrap;
      }

      li.mine .who {
        color: var(--ink);
      }

      li.mine .who::after {
        content: ' (you)';
        color: var(--ink-2);
        font-weight: 400;
      }

      .what {
        overflow-wrap: anywhere;
      }

      time {
        font: 400 0.68rem/1.7 var(--font-data);
        color: var(--ink-2);
        font-variant-numeric: tabular-nums;
      }

      .empty {
        display: block;
        color: var(--ink-2);
        font-size: 0.82rem;
      }

      .row {
        display: flex;
        gap: 8px;
      }

      input {
        flex: 1 1 auto;
        min-width: 0;
      }

      .clip {
        margin: 8px 0 0;
        font-size: 0.74rem;
        line-height: 1.4;
        color: var(--ink-2);
      }
    `,
  ];

  @state() private draft = '';

  /**
   * Runs the draft through the server's own validation — the shared Rust, via
   * wasm — and reports the limit only when the text would actually be cut.
   */
  private clippedTo(): number | null {
    const text = this.draft.trim();
    if (!text) {
      return null;
    }

    try {
      const said = validateSay('', text);
      return said.text === text ? null : said.text.length;
    } catch {
      return null;
    }
  }

  override render() {
    const room = transport.room.get();
    const limit = this.clippedTo();

    return html`
      <section class="panel reliable">
        <header>
          <span class="eyebrow">Stream out, push stream in</span>
          <h2>Room</h2>
        </header>

        <ol class="lines">
          ${
            room.length
              ? repeat(
                  room,
                  (line) => line.id,
                  (line) => html`
                    <li class=${line.mine ? 'mine' : ''}>
                      <span class="who">${line.author}</span>
                      <span class="what">${line.text}</span>
                      <time>${fmtTime(line.atMs)}</time>
                    </li>
                  `,
                )
              : html`
                  <li class="empty">
                    Nothing said yet. Open this page in a second tab and the lines will land in
                    both.
                  </li>
                `
          }
        </ol>

        <div class="row">
          <input
            type="text"
            .value=${this.draft}
            ?disabled=${!transport.online.get()}
            placeholder="Say something to every session"
            aria-label="Message"
            @input=${(event: Event) => (this.draft = (event.target as HTMLInputElement).value)}
            @keydown=${(event: KeyboardEvent) => event.key === 'Enter' && this.send()}
          />
          <button ?disabled=${!transport.online.get() || !this.draft.trim()} @click=${this.send}>
            Send
          </button>
        </div>

        ${
          limit
            ? html`
                <p class="clip">
                  Only the first ${limit} characters will be broadcast — trimmed here by the same
                  Rust rule the server enforces.
                </p>
              `
            : ''
        }
      </section>
    `;
  }

  private send = async (): Promise<void> => {
    const text = this.draft.trim();
    if (!text || !transport.online.get()) {
      return;
    }

    this.draft = '';
    await transport.say(text).catch(() => undefined);
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'wt-room-panel': RoomPanel;
  }
}
