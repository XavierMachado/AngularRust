import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { TransportService } from './core/transport.service';
import { humanBytes } from './core/wasm';
import { DatagramPanel } from './panels/datagram-panel';
import { EventLog } from './panels/event-log';
import { RequestPanel } from './panels/request-panel';
import { RoomPanel } from './panels/room-panel';
import { StreamLedger } from './panels/stream-ledger';
import { UploadPanel } from './panels/upload-panel';

@Component({
  selector: 'wt-root',
  imports: [
    FormsModule,
    StreamLedger,
    RequestPanel,
    DatagramPanel,
    RoomPanel,
    UploadPanel,
    EventLog,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="masthead">
      <p class="eyebrow">QUIC · HTTP/3 · one connection, two guarantees</p>

      <div class="title">
        <h1>WebTransport console</h1>

        <div class="link">
          <span class="pill" [class]="transport.state()">{{ transport.state() }}</span>

          @if (transport.online()) {
            <button type="button" class="ghost" (click)="transport.disconnect()">Disconnect</button>
          } @else {
            <input
              type="text"
              [(ngModel)]="name"
              placeholder="your name"
              aria-label="Name to use in the room"
              [disabled]="transport.busy()"
            />
            <button type="button" (click)="connect()" [disabled]="transport.busy()">
              {{ transport.busy() ? 'Connecting…' : 'Connect' }}
            </button>
          }
        </div>
      </div>

      <p class="detail">{{ transport.detail() }}</p>

      <dl class="readout">
        <div>
          <dt>Endpoint</dt>
          <dd>{{ transport.endpoint() ?? 'unknown until connect' }}</dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{{ transport.sessionId() ?? '—' }}</dd>
        </div>
        <div class="wide">
          <dt>Certificate sha-256</dt>
          <dd class="hash">{{ fingerprint() }}</dd>
        </div>
      </dl>
    </header>

    <main>
      <wt-stream-ledger />

      @if (telemetry(); as stats) {
        <dl class="telemetry">
          <div>
            <dt>Sessions</dt>
            <dd>{{ stats.sessions }}</dd>
          </div>
          <div>
            <dt>Frames in</dt>
            <dd>{{ stats.framesIn }}</dd>
          </div>
          <div>
            <dt>Datagrams in</dt>
            <dd>{{ stats.datagramsIn }}</dd>
          </div>
          <div>
            <dt>Bytes in</dt>
            <dd>{{ bytes() }}</dd>
          </div>
          <div>
            <dt>Server uptime</dt>
            <dd>{{ uptime() }}</dd>
          </div>
        </dl>
      }

      <div class="grid">
        <wt-request-panel />
        <wt-datagram-panel />
        <wt-room-panel />
        <wt-upload-panel />
      </div>

      <wt-event-log />
    </main>

    <footer>
      <p>
        The certificate is generated fresh on every server start and trusted by fingerprint, which
        is a development shortcut. In production the server holds a normal CA-issued certificate and
        the client passes no hashes at all.
      </p>
    </footer>
  `,
  styles: `
    :host {
      display: block;
      max-width: 1120px;
      margin: 0 auto;
      padding: 40px 24px 64px;
    }

    .masthead {
      margin-bottom: 26px;
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

    .link input {
      width: 12ch;
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

    .detail {
      margin: 0 0 16px;
      color: var(--ink-2);
      font-size: 0.86rem;
    }

    .readout,
    .telemetry {
      display: grid;
      gap: 12px 26px;
      margin: 0;
    }

    .readout {
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      padding-top: 14px;
      border-top: 1px solid var(--rule);
    }

    .readout .wide {
      grid-column: 1 / -1;
    }

    .telemetry {
      grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
      margin: 18px 0 22px;
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

    .telemetry dd {
      font-size: 1.1rem;
      font-weight: 500;
    }

    .hash {
      font-size: 0.72rem;
      color: var(--ink-2);
      letter-spacing: 0.02em;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(330px, 1fr));
      gap: 18px;
      margin: 22px 0;
    }

    footer {
      margin-top: 30px;
      padding-top: 16px;
      border-top: 1px solid var(--rule);
    }

    footer p {
      margin: 0;
      max-width: 62ch;
      font-size: 0.78rem;
      line-height: 1.6;
      color: var(--ink-2);
    }
  `,
})
export class App {
  protected readonly transport = inject(TransportService);
  protected readonly name = signal(suggestName());

  protected readonly telemetry = computed(() => this.transport.telemetry());

  protected readonly fingerprint = computed(() => {
    const hex = this.transport.fingerprint();
    if (!hex) {
      return 'fetched from the server at connect time';
    }

    return (hex.match(/.{2}/g) ?? []).join(':');
  });

  // The same formatter the server uses in its upload notices, via wasm.
  protected readonly bytes = computed(() => {
    const stats = this.transport.telemetry();
    return stats ? humanBytes(stats.bytesIn) : '0 B';
  });

  protected readonly uptime = computed(() => {
    const stats = this.transport.telemetry();
    if (!stats) {
      return '—';
    }

    const minutes = Math.floor(stats.uptimeSecs / 60);
    const seconds = stats.uptimeSecs % 60;

    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  });

  protected connect(): void {
    void this.transport.connect(this.name().trim() || 'anonymous');
  }
}

/** Saves the visitor from naming themselves before they can try anything. */
function suggestName(): string {
  const names = ['ash', 'birch', 'cedar', 'elm', 'fir', 'hazel', 'linden', 'rowan'];
  return names[Math.floor(Math.random() * names.length)];
}
