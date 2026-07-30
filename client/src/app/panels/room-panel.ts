import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { TransportService } from '../core/transport.service';
import { validateSay } from '../core/wasm';

/**
 * Send on a bidirectional stream, receive on the server's push stream. Open a
 * second browser tab to see the fan-out.
 */
@Component({
  selector: 'wt-room-panel',
  imports: [FormsModule, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel reliable">
      <header>
        <span class="eyebrow">Stream out, push stream in</span>
        <h2>Room</h2>
      </header>

      <ol class="lines">
        @for (line of transport.room(); track line.id) {
          <li [class.mine]="line.mine">
            <span class="who">{{ line.author }}</span>
            <span class="what">{{ line.text }}</span>
            <time>{{ line.atMs | date: 'HH:mm:ss' }}</time>
          </li>
        } @empty {
          <li class="empty">
            Nothing said yet. Open this page in a second tab and the lines will land in both.
          </li>
        }
      </ol>

      <div class="row">
        <input
          type="text"
          [(ngModel)]="draft"
          (keydown.enter)="send()"
          [disabled]="!transport.online()"
          placeholder="Say something to every session"
          aria-label="Message"
        />
        <button type="button" (click)="send()" [disabled]="!transport.online() || !draft().trim()">
          Send
        </button>
      </div>

      @if (clippedTo(); as limit) {
        <p class="clip">
          Only the first {{ limit }} characters will be broadcast — trimmed here by the same Rust
          rule the server enforces.
        </p>
      }
    </section>
  `,
  styles: `
    .lines {
      list-style: none;
      margin: 0 0 12px;
      padding: 0;
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
})
export class RoomPanel {
  protected readonly transport = inject(TransportService);
  protected readonly draft = signal('');

  /**
   * Runs the draft through the server's own validation — the shared Rust, via
   * wasm — and reports the limit only when the text would actually be cut.
   */
  protected readonly clippedTo = computed(() => {
    const text = this.draft().trim();
    if (!text) {
      return null;
    }

    try {
      const said = validateSay('', text);
      return said.text === text ? null : said.text.length;
    } catch {
      return null;
    }
  });

  protected async send(): Promise<void> {
    const text = this.draft().trim();
    if (!text || !this.transport.online()) {
      return;
    }

    this.draft.set('');
    await this.transport.say(text).catch(() => undefined);
  }
}
