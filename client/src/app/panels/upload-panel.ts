import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { TransportService } from '../core/transport.service';

/** Bytes one way, no reply. The shape of a file upload. */
@Component({
  selector: 'wt-upload-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel reliable">
      <header>
        <span class="eyebrow">{{ emulated() ? 'Upload lane' : 'Unidirectional stream' }}</span>
        <h2>Send bulk</h2>
      </header>

      @if (emulated()) {
        <p class="lede">
          Writes 16 KiB at a time on the socket's own upload lane — raw bytes, not base64 — and
          waits when <code>bufferedAmount</code> says the send buffer is full. That is a number you
          poll rather than a promise you await, which is the closest a WebSocket gets to a stream's
          flow control. The server reads to the end, times it, and announces the rate to every
          session.
        </p>
      } @else {
        <p class="lede">
          Writes 16 KiB at a time and waits when the stream's flow control says wait. The server
          reads to the end, times it, and announces the rate to every session.
        </p>
      }

      <div class="row">
        @for (size of sizes; track size) {
          <button type="button" (click)="send(size)" [disabled]="busy() || !transport.online()">
            {{ label(size) }}
          </button>
        }
      </div>

      <p class="status" [class.working]="busy()">{{ status() }}</p>
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
      margin-bottom: 12px;
    }

    .status {
      margin: 0;
      font: 400 0.78rem/1.5 var(--font-data);
      color: var(--ink-2);
    }

    .status.working {
      color: var(--reliable);
    }
  `,
})
export class UploadPanel {
  protected readonly transport = inject(TransportService);
  protected readonly sizes = [256, 2048, 16384];
  protected readonly busy = signal(false);
  protected readonly status = signal('Idle.');

  /**
   * Reused as "is this the WebSocket", because the two differences that matter
   * here — a lane instead of a stream, polled instead of awaited backpressure —
   * arrive together with the emulated datagrams.
   */
  protected readonly emulated = this.transport.datagramsEmulated;

  protected label(kibibytes: number): string {
    return kibibytes >= 1024 ? `${kibibytes / 1024} MiB` : `${kibibytes} KiB`;
  }

  protected async send(kibibytes: number): Promise<void> {
    this.busy.set(true);
    this.status.set(`Sending ${this.label(kibibytes)}…`);

    const started = performance.now();

    try {
      await this.transport.upload(kibibytes);

      const seconds = (performance.now() - started) / 1000;
      const rate = kibibytes / 1024 / Math.max(seconds, 0.001);
      this.status.set(
        `Sent ${this.label(kibibytes)} in ${(seconds * 1000).toFixed(0)} ms, ` +
          `${rate.toFixed(1)} MiB/s as measured here.`,
      );
    } catch (error) {
      this.status.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }
}
