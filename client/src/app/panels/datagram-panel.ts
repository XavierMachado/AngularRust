import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core';

import { TransportService } from '../core/transport.service';

/** Ping and pong over datagrams. The unreliable path. */
@Component({
  selector: 'wt-datagram-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel unreliable" [class.emulated]="emulated()">
      <header>
        <span class="eyebrow">Datagrams</span>
        <h2>Round trip</h2>
        @if (emulated()) {
          <span class="badge">emulated</span>
        }
      </header>

      @if (emulated()) {
        <p class="lede">
          This connection has no datagram channel. Ping and pong here ride the same ordered,
          reliable socket as everything else: nothing will be lost, nothing reordered, and
          Unanswered should stay at zero. What the chart measures is queueing delay behind whatever
          else is on the socket — a real number, about a different thing.
        </p>
      } @else {
        <p class="lede">
          Datagrams skip retransmission and ordering entirely. A missing pong is the transport
          working as designed, not a bug.
        </p>
      }

      <div class="row">
        <button type="button" (click)="once()" [disabled]="!transport.online()">Send one</button>
        <button
          type="button"
          class="ghost"
          (click)="toggle()"
          [disabled]="!transport.online() && !running()"
        >
          {{ running() ? 'Stop' : 'Send twice a second' }}
        </button>
      </div>

      <dl class="stats">
        <div>
          <dt>Last</dt>
          <dd>{{ show(transport.lastRtt()) }}</dd>
        </div>
        <div>
          <dt>Median</dt>
          <dd>{{ show(transport.medianRtt()) }}</dd>
        </div>
        <div>
          <dt>Unanswered</dt>
          @if (emulated()) {
            <dd class="muted" title="A reliable channel cannot lose one, so this cannot be news.">
              n/a
            </dd>
          } @else {
            <dd>{{ transport.lostDatagrams() }}</dd>
          }
        </div>
      </dl>

      @if (path().length) {
        <svg
          viewBox="0 0 300 60"
          preserveAspectRatio="none"
          role="img"
          aria-label="Round trip times"
        >
          <polyline [attr.points]="path()" />
        </svg>
        <p class="scale">0 to {{ ceiling() }} ms, most recent on the right</p>
      } @else {
        <p class="scale">No samples yet.</p>
      }
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

    .badge {
      margin-left: auto;
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
})
export class DatagramPanel implements OnDestroy {
  protected readonly transport = inject(TransportService);
  protected readonly running = signal(false);

  /** True when the live transport has no datagram channel and is faking one. */
  protected readonly emulated = this.transport.datagramsEmulated;

  protected readonly ceiling = computed(() => {
    const samples = this.transport.rtt();
    const peak = samples.reduce((high, sample) => Math.max(high, sample.ms), 1);
    return Math.ceil(peak);
  });

  protected readonly path = computed(() => {
    const samples = this.transport.rtt().slice(-60);
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
  });

  private timer = 0;

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }

  protected show(value: number | null): string {
    return value === null ? '—' : `${value.toFixed(1)} ms`;
  }

  protected async once(): Promise<void> {
    await this.transport.ping().catch(() => undefined);
  }

  protected toggle(): void {
    if (this.running()) {
      clearInterval(this.timer);
      this.running.set(false);
      return;
    }

    this.running.set(true);
    this.timer = setInterval(() => {
      if (!this.transport.online()) {
        clearInterval(this.timer);
        this.running.set(false);
        return;
      }

      void this.transport.ping().catch(() => undefined);
    }, 500) as unknown as number;
  }
}
