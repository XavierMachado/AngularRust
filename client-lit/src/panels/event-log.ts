import { SignalWatcher } from '@lit-labs/signals';
import { LitElement, css, html } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import type { LogLevel } from '../core/protocol';
import { transport, type LogLine } from '../store/transport';
import { fmtTime } from './format';
import { controlStyles, panelStyles } from './shared-styles';

/** Ordered loudest first, which is also the filter order. */
const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];

/**
 * The unified log: this client's own events interleaved with `tracing` records
 * forwarded from the Rust server, on one timeline.
 *
 * When a request fails, the reason is usually on the other side of the
 * connection. Putting both accounts in one place, ordered by time, means the
 * browser is the only window that needs to be open.
 */
@customElement('wt-event-log')
export class EventLog extends SignalWatcher(LitElement) {
  static override styles = [
    panelStyles,
    controlStyles,
    css`
      header {
        display: flex;
        flex-wrap: wrap;
        gap: 12px 18px;
        align-items: flex-end;
        justify-content: space-between;
        margin-bottom: 12px;
      }

      .heading h2 {
        margin: 2px 0 0;
      }

      .controls {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: center;
      }

      input[type='search'] {
        width: 16ch;
      }

      ol {
        list-style: none;
        margin: 0;
        padding: 12px;
        background: var(--paper);
        border-radius: 10px;
        max-height: var(--log-height, 340px);
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 3px;
        scroll-behavior: smooth;
      }

      li {
        display: grid;
        grid-template-columns: 11ch 5ch 4ch 14ch 1fr;
        gap: 10px;
        font: 400 0.74rem/1.6 var(--font-data);
        padding: 1px 0;
      }

      time {
        color: var(--ink-2);
        font-variant-numeric: tabular-nums;
      }

      .level,
      .origin {
        font-size: 0.62rem;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        line-height: 2.1;
        color: var(--ink-2);
      }

      /* The rule down the left is what separates the two accounts at a glance. */
      li.server {
        border-left: 2px solid var(--reliable);
        padding-left: 8px;
        margin-left: -10px;
      }

      li.server .origin {
        color: var(--reliable);
      }

      li.warn .level,
      li.warn .text {
        color: var(--alert);
      }

      li.error .level,
      li.error .text {
        color: var(--unreliable);
        font-weight: 500;
      }

      li.debug,
      li.trace {
        opacity: 0.72;
      }

      .source {
        color: var(--ink-2);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .text {
        overflow-wrap: anywhere;
      }

      .chip,
      .field {
        display: inline-block;
        margin-left: 6px;
        padding: 0 6px;
        border-radius: 4px;
        font-size: 0.66rem;
        background: color-mix(in srgb, var(--reliable) 12%, transparent);
        color: var(--reliable);
      }

      .field {
        background: transparent;
        border: 1px solid var(--rule);
        color: var(--ink-2);
      }

      li.empty {
        display: block;
        color: var(--ink-2);
      }

      .foot {
        margin: 8px 0 0;
        font: 400 0.7rem/1.5 var(--font-data);
        color: var(--ink-2);
      }

      button.link {
        background: none;
        border: none;
        padding: 0;
        font: inherit;
        color: var(--reliable);
        text-decoration: underline;
        cursor: pointer;
      }

      @media (max-width: 720px) {
        li {
          grid-template-columns: 9ch 1fr;
        }

        .level,
        .origin,
        .source {
          display: none;
        }
      }
    `,
  ];

  @state() private query_ = '';
  @state() private origin: 'all' | 'server' | 'client' = 'all';
  @state() private floor: LogLevel = 'debug';
  @state() private copied = false;
  /** False once the reader scrolls up, so new lines stop yanking the view. */
  @state() private stuck = true;

  @query('ol') private scroller!: HTMLOListElement;

  private visible(): LogLine[] {
    const needle = this.query_.trim().toLowerCase();
    const origin = this.origin;
    const depth = LEVELS.indexOf(this.floor);

    return transport.log.get().filter((line) => {
      if (origin !== 'all' && line.origin !== origin) {
        return false;
      }

      if (LEVELS.indexOf(line.level) > depth) {
        return false;
      }

      if (!needle) {
        return true;
      }

      return (
        line.text.toLowerCase().includes(needle) ||
        line.source.toLowerCase().includes(needle) ||
        (line.session ?? '').toLowerCase().includes(needle)
      );
    });
  }

  override render() {
    const visible = this.visible();
    const total = transport.log.get().length;

    return html`
      <section class="panel">
        <header>
          <div class="heading">
            <span class="eyebrow">Client and server, one timeline</span>
            <h2>Log</h2>
          </div>

          <div class="controls">
            <input
              type="search"
              .value=${this.query_}
              placeholder="filter text"
              aria-label="Filter log text"
              @input=${(event: Event) => (this.query_ = (event.target as HTMLInputElement).value)}
            />

            <select
              .value=${this.origin}
              aria-label="Source"
              @change=${(event: Event) =>
                (this.origin = (event.target as HTMLSelectElement).value as typeof this.origin)}
            >
              <option value="all">both sides</option>
              <option value="server">server only</option>
              <option value="client">client only</option>
            </select>

            <select
              .value=${this.floor}
              aria-label="Lowest level"
              @change=${(event: Event) =>
                (this.floor = (event.target as HTMLSelectElement).value as LogLevel)}
            >
              ${LEVELS.map((level) => html`<option value=${level}>${level} and up</option>`)}
            </select>

            <button class="ghost small" @click=${this.copy}>
              ${this.copied ? 'Copied' : 'Copy'}
            </button>
            <button class="ghost small" @click=${() => transport.clearLog()}>Clear</button>
          </div>
        </header>

        <ol @scroll=${this.onScroll}>
          ${
            visible.length
              ? repeat(
                  visible,
                  (line) => line.id,
                  (line) => html`
                    <li class="${line.level} ${line.origin === 'server' ? 'server' : ''}">
                      <time>${fmtTime(line.at, true)}</time>
                      <span class="level">${line.level}</span>
                      <span class="origin">${line.origin === 'server' ? 'rust' : 'web'}</span>
                      <span class="source" title=${line.source}>${short(line.source)}</span>
                      <span class="text">
                        ${line.text}
                        ${line.session ? html`<span class="chip">${line.session}</span>` : ''}
                        ${fieldsOf(line).map(
                          ([name, value]) => html`<span class="field">${name}=${value}</span>`,
                        )}
                      </span>
                    </li>
                  `,
                )
              : html`
                  <li class="empty">
                    ${
                      total
                        ? html`Nothing matches this filter. ${total} lines are hidden.`
                        : html`Connect to start the log. The server replays its recent history on
                          the way in.`
                    }
                  </li>
                `
          }
        </ol>

        <p class="foot">
          ${visible.length} of ${total} lines
          ${
            !this.stuck
              ? html`·
                  <button type="button" class="link" @click=${this.jump}>jump to newest</button>`
              : ''
          }
        </p>
      </section>
    `;
  }

  override updated(): void {
    // Follow the tail, unless the reader has deliberately scrolled away from it.
    if (this.stuck) {
      requestAnimationFrame(() => this.jump());
    }
  }

  private onScroll = (): void => {
    const element = this.scroller;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;

    this.stuck = distance < 24;
  };

  private jump = (): void => {
    const element = this.scroller;
    if (!element) {
      return;
    }

    element.scrollTop = element.scrollHeight;
    this.stuck = true;
  };

  /** Hands the filtered view to the clipboard, ready to paste into an issue. */
  private copy = async (): Promise<void> => {
    const text = this.visible()
      .map((line) => {
        const stamp = new Date(line.at).toISOString();
        const fields = fieldsOf(line)
          .map(([name, value]) => ` ${name}=${value}`)
          .join('');

        return (
          `${stamp} ${line.level.toUpperCase().padEnd(5)} ` +
          `[${line.origin}] ${line.source}: ${line.text}${fields}`
        );
      })
      .join('\n');

    try {
      await navigator.clipboard.writeText(text);
      this.copied = true;
      setTimeout(() => (this.copied = false), 1500);
    } catch {
      transport.note('app', 'The clipboard is not available in this context.', 'warn');
    }
  };
}

function short(source: string): string {
  return source.startsWith('wt_server::') ? source.slice('wt_server::'.length) : source;
}

function fieldsOf(line: LogLine): [string, string][] {
  // `id` is the session span's own field and is already shown as the chip.
  return Object.entries(line.fields ?? {}).filter(([name]) => name !== 'id');
}

declare global {
  interface HTMLElementTagNameMap {
    'wt-event-log': EventLog;
  }
}
