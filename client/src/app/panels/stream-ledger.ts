import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  inject,
  viewChild,
} from '@angular/core';

import { LEDGER_WINDOW_MS, TransportService } from '../core/transport.service';

/**
 * The ledger: a twenty second window of everything crossing the connection.
 *
 * The horizontal rule is the connection. Reliable stream traffic ticks upward,
 * datagrams tick downward, and the split is the point: both lanes share one
 * QUIC connection but make opposite promises. Outbound ticks are solid,
 * inbound are hollow.
 */
@Component({
  selector: 'wt-stream-ledger',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure class="ledger">
      <figcaption>
        <span class="eyebrow">Last 20 seconds</span>
        <span class="key">
          <i class="swatch reliable"></i>streams, reliable
          <i class="swatch unreliable"></i>datagrams, unreliable
        </span>
      </figcaption>
      <canvas #surface aria-hidden="true"></canvas>
      <p class="reading">{{ reading() }}</p>
    </figure>
  `,
  styles: `
    .ledger {
      margin: 0;
      padding: 20px 22px 14px;
      background: var(--surface);
      border: 1px solid var(--rule);
      border-radius: 14px;
    }

    figcaption {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 18px;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 6px;
    }

    .key {
      font: 500 0.7rem/1 var(--font-data);
      color: var(--ink-2);
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .swatch {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      display: inline-block;
    }

    .swatch:not(:first-child) {
      margin-left: 10px;
    }

    .swatch.reliable {
      background: var(--reliable);
    }

    .swatch.unreliable {
      background: var(--unreliable);
    }

    canvas {
      display: block;
      width: 100%;
      height: 148px;
    }

    .reading {
      margin: 4px 0 0;
      font: 400 0.75rem/1.4 var(--font-data);
      color: var(--ink-2);
    }
  `,
})
export class StreamLedger implements AfterViewInit, OnDestroy {
  private readonly transport = inject(TransportService);
  private readonly surface = viewChild.required<ElementRef<HTMLCanvasElement>>('surface');

  private context: CanvasRenderingContext2D | null = null;
  private observer: ResizeObserver | null = null;
  private frame = 0;
  private timer = 0;

  readonly reading = () => {
    const ticks = this.transport.ticks();
    if (!ticks.length) {
      return 'Idle. Nothing has crossed the connection yet.';
    }

    const streams = ticks.filter((tick) => tick.lane === 'stream').length;
    const datagrams = ticks.length - streams;

    return `${streams} stream events, ${datagrams} datagrams`;
  };

  ngAfterViewInit(): void {
    const canvas = this.surface().nativeElement;
    this.context = canvas.getContext('2d');

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();

    // A scrolling time axis needs a repaint even when no data arrives, so this
    // is driven by the clock rather than by change detection. Anyone who asked
    // for less motion gets four repaints a second instead of sixty.
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced) {
      this.timer = setInterval(() => this.draw(), 250) as unknown as number;
    } else {
      const loop = () => {
        this.draw();
        this.frame = requestAnimationFrame(loop);
      };

      this.frame = requestAnimationFrame(loop);
    }
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frame);
    clearInterval(this.timer);
    this.observer?.disconnect();
  }

  private resize(): void {
    const canvas = this.surface().nativeElement;
    const ratio = devicePixelRatio || 1;
    const bounds = canvas.getBoundingClientRect();

    canvas.width = Math.max(1, Math.round(bounds.width * ratio));
    canvas.height = Math.max(1, Math.round(bounds.height * ratio));

    this.context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.draw();
  }

  private draw(): void {
    const context = this.context;
    if (!context) {
      return;
    }

    const canvas = this.surface().nativeElement;
    const ratio = devicePixelRatio || 1;
    const width = canvas.width / ratio;
    const height = canvas.height / ratio;
    const middle = Math.round(height / 2) + 0.5;

    context.clearRect(0, 0, width, height);

    const styles = getComputedStyle(canvas);
    const rule = styles.getPropertyValue('--rule').trim() || '#c3cdd9';
    const faint = styles.getPropertyValue('--ink-2').trim() || '#4a5b72';
    const reliable = styles.getPropertyValue('--reliable').trim() || '#00707d';
    const unreliable = styles.getPropertyValue('--unreliable').trim() || '#c4006a';

    // Time axis: five second gridlines, now at the right edge.
    context.font = `500 10px ${styles.getPropertyValue('--font-data').trim() || 'monospace'}`;
    context.textAlign = 'center';

    for (let seconds = 0; seconds <= LEDGER_WINDOW_MS / 1000; seconds += 5) {
      const x = Math.round(width - (seconds / (LEDGER_WINDOW_MS / 1000)) * width) + 0.5;

      context.strokeStyle = rule;
      context.globalAlpha = 0.55;
      context.beginPath();
      context.moveTo(x, 8);
      context.lineTo(x, height - 8);
      context.stroke();

      context.globalAlpha = 0.75;
      context.fillStyle = faint;
      context.fillText(
        seconds === 0 ? 'now' : `-${seconds}s`,
        Math.min(width - 14, Math.max(14, x)),
        height - 1,
      );
    }

    context.globalAlpha = 1;

    // The connection itself.
    context.strokeStyle = faint;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, middle);
    context.lineTo(width, middle);
    context.stroke();

    const now = performance.now();
    const reach = height / 2 - 16;

    for (const tick of this.transport.ticks()) {
      const age = now - tick.at;
      if (age > LEDGER_WINDOW_MS) {
        continue;
      }

      const x = Math.round(width - (age / LEDGER_WINDOW_MS) * width) + 0.5;
      const length = Math.max(4, reach * tick.weight);
      const up = tick.lane === 'stream';

      context.strokeStyle = up ? reliable : unreliable;
      context.globalAlpha = tick.direction === 'out' ? 1 : 0.42;
      context.lineWidth = tick.direction === 'out' ? 2 : 1.5;

      context.beginPath();
      context.moveTo(x, middle + (up ? -1 : 1));
      context.lineTo(x, middle + (up ? -length : length));
      context.stroke();
    }

    context.globalAlpha = 1;
  }
}
