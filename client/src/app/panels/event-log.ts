import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { LogLevel } from '../core/protocol';
import { TransportService, type LogLine } from '../core/transport.service';

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
@Component({
  selector: 'wt-event-log',
  imports: [DatePipe, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel">
      <header>
        <div class="heading">
          <span class="eyebrow">Client and server, one timeline</span>
          <h2>Log</h2>
        </div>

        <div class="controls">
          <input
            type="search"
            [(ngModel)]="query"
            placeholder="filter text"
            aria-label="Filter log text"
          />

          <select [ngModel]="origin()" (ngModelChange)="origin.set($event)" aria-label="Source">
            <option value="all">both sides</option>
            <option value="server">server only</option>
            <option value="client">client only</option>
          </select>

          <select [ngModel]="floor()" (ngModelChange)="floor.set($event)" aria-label="Lowest level">
            @for (level of levels; track level) {
              <option [value]="level">{{ level }} and up</option>
            }
          </select>

          <button type="button" class="ghost small" (click)="copy()">
            {{ copied() ? 'Copied' : 'Copy' }}
          </button>
          <button type="button" class="ghost small" (click)="transport.clearLog()">Clear</button>
        </div>
      </header>

      <ol #scroller (scroll)="onScroll()">
        @for (line of visible(); track line.id) {
          <li [class]="line.level" [class.server]="line.origin === 'server'">
            <time>{{ line.at | date: 'HH:mm:ss.SSS' }}</time>
            <span class="level">{{ line.level }}</span>
            <span class="origin">{{ line.origin === 'server' ? 'rust' : 'web' }}</span>
            <span class="source" [title]="line.source">{{ short(line.source) }}</span>
            <span class="text">
              {{ line.text }}
              @if (line.session) {
                <span class="chip">{{ line.session }}</span>
              }
              @for (field of fieldsOf(line); track field[0]) {
                <span class="field">{{ field[0] }}={{ field[1] }}</span>
              }
            </span>
          </li>
        } @empty {
          <li class="empty">
            @if (transport.log().length) {
              Nothing matches this filter. {{ transport.log().length }} lines are hidden.
            } @else {
              Connect to start the log. The server replays its recent history on the way in.
            }
          </li>
        }
      </ol>

      <p class="foot">
        {{ visible().length }} of {{ transport.log().length }} lines
        @if (!stuck()) {
          · <button type="button" class="link" (click)="jump()">jump to newest</button>
        }
      </p>
    </section>
  `,
  styles: `
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

    select {
      font: 400 0.74rem/1 var(--font-data);
      color: var(--ink);
      background: #fff;
      border: 1px solid var(--rule);
      border-radius: 8px;
      padding: 9px 10px;
    }

    ol {
      list-style: none;
      margin: 0;
      padding: 12px;
      background: var(--paper);
      border-radius: 10px;
      max-height: 340px;
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
})
export class EventLog {
  protected readonly transport = inject(TransportService);
  protected readonly levels = LEVELS;

  protected readonly query = signal('');
  protected readonly origin = signal<'all' | 'server' | 'client'>('all');
  protected readonly floor = signal<LogLevel>('debug');
  protected readonly copied = signal(false);
  /** False once the reader scrolls up, so new lines stop yanking the view. */
  protected readonly stuck = signal(true);

  private readonly scroller = viewChild.required<ElementRef<HTMLOListElement>>('scroller');

  protected readonly visible = computed(() => {
    const needle = this.query().trim().toLowerCase();
    const origin = this.origin();
    const depth = LEVELS.indexOf(this.floor());

    return this.transport.log().filter((line) => {
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
  });

  constructor() {
    // Follow the tail, unless the reader has deliberately scrolled away from it.
    effect(() => {
      this.visible();

      if (this.stuck()) {
        requestAnimationFrame(() => this.jump());
      }
    });
  }

  protected short(source: string): string {
    return source.startsWith('wt_server::') ? source.slice('wt_server::'.length) : source;
  }

  protected fieldsOf(line: LogLine): [string, string][] {
    // `id` is the session span's own field and is already shown as the chip.
    return Object.entries(line.fields ?? {}).filter(([name]) => name !== 'id');
  }

  protected onScroll(): void {
    const element = this.scroller().nativeElement;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;

    this.stuck.set(distance < 24);
  }

  protected jump(): void {
    const element = this.scroller().nativeElement;
    element.scrollTop = element.scrollHeight;
    this.stuck.set(true);
  }

  /** Hands the filtered view to the clipboard, ready to paste into an issue. */
  protected async copy(): Promise<void> {
    const text = this.visible()
      .map((line) => {
        const stamp = new Date(line.at).toISOString();
        const fields = this.fieldsOf(line)
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
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      this.transport.note('app', 'The clipboard is not available in this context.', 'warn');
    }
  }
}
