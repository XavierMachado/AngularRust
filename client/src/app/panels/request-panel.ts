import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { Reply, Request } from '../core/protocol';
import { TransportService } from '../core/transport.service';
import { fibLocal } from '../core/wasm';

/** One request, one reply, one stream. The reliable path. */
@Component({
  selector: 'wt-request-panel',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel reliable">
      <header>
        <span class="eyebrow">Bidirectional stream</span>
        <h2>Ask the server</h2>
      </header>

      <p class="lede">
        Each request opens its own stream and closes it when the reply lands. Send a slow one and a
        fast one together to watch them overtake each other. The Fibonacci row can also run the same
        Rust right here through wasm — no server involved.
      </p>

      <div class="row">
        <input
          type="text"
          [(ngModel)]="text"
          [disabled]="!transport.online()"
          placeholder="anything at all"
          aria-label="Text to send"
        />
        <button type="button" (click)="send({ op: 'echo', text: text() })" [disabled]="idle()">
          Echo
        </button>
        <button type="button" (click)="send({ op: 'reverse', text: text() })" [disabled]="idle()">
          Reverse
        </button>
      </div>

      <div class="row">
        <label for="fib">Fibonacci</label>
        <input id="fib" type="number" min="0" max="185" [(ngModel)]="n" />
        <button type="button" (click)="send({ op: 'fib', n: n() })" [disabled]="idle()">
          On the server
        </button>
        <button type="button" (click)="fibHere()">In this tab</button>
        <button type="button" class="ghost" (click)="send({ op: 'ping' })" [disabled]="idle()">
          Ping
        </button>
      </div>

      <output>
        @if (inFlight()) {
          <span class="waiting">Waiting for {{ inFlight() }} reply…</span>
        } @else if (result()) {
          <code>{{ result() }}</code>
        } @else {
          <span class="empty">No reply yet.</span>
        }
      </output>
    </section>
  `,
  styles: `
    .lede {
      margin: 0 0 14px;
      color: var(--ink-2);
      font-size: 0.83rem;
      line-height: 1.5;
    }

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

    input[type='text'] {
      flex: 1 1 12ch;
      min-width: 0;
    }

    input[type='number'] {
      width: 7ch;
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
      content: '';
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
})
export class RequestPanel {
  protected readonly transport = inject(TransportService);

  protected readonly text = signal('the quick brown fox');
  protected readonly n = signal(90);
  protected readonly result = signal('');
  protected readonly inFlight = signal<string | null>(null);

  protected idle(): boolean {
    return !this.transport.online() || this.inFlight() !== null;
  }

  protected async send(request: Request): Promise<void> {
    this.inFlight.set(request.op);
    this.result.set('');

    const started = performance.now();

    try {
      const reply = await this.transport.request(request);
      const elapsed = Math.round((performance.now() - started) * 10) / 10;
      this.result.set(`${render(reply)}   ·   ${elapsed} ms round trip`);
    } catch (error) {
      this.result.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.inFlight.set(null);
    }
  }

  /**
   * The identical `wt_shared::compute::fib`, but through wasm instead of a
   * round trip — which is why it works with the connection down, and why the
   * value always matches what "On the server" returns.
   */
  protected fibHere(): void {
    const started = performance.now();

    try {
      const value = fibLocal(this.n());
      const micros = Math.max(1, Math.round((performance.now() - started) * 1000));
      this.result.set(`fib(${this.n()}) = ${value}   ·   ${micros} µs in this tab, via wasm`);
    } catch (error) {
      this.result.set(error instanceof Error ? error.message : String(error));
    }
  }
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
