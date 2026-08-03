import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { TransportService } from '../core/transport.service';
import { humanBytes } from '../core/wasm';
import { DatagramPanel } from '../panels/datagram-panel';
import { RequestPanel } from '../panels/request-panel';
import { RoomPanel } from '../panels/room-panel';
import { StreamLedger } from '../panels/stream-ledger';
import { UploadPanel } from '../panels/upload-panel';

/** The landing page: the ledger, the telemetry strip and the four lane panels. */
@Component({
  selector: 'wt-console-page',
  imports: [StreamLedger, RequestPanel, DatagramPanel, RoomPanel, UploadPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <wt-stream-ledger />

    @if (telemetry(); as stats) {
      <dl class="telemetry">
        <div>
          <dt>Sessions</dt>
          <dd>
            {{ stats.sessions }}
            <span class="split"
              >{{ stats.sessionsWebtransport }} wt / {{ stats.sessionsWebsocket }} ws</span
            >
          </dd>
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

    <footer>
      <p>
        The certificate is generated fresh on every server start and trusted by fingerprint, which
        is a development shortcut. In production the server holds a normal CA-issued certificate and
        the client passes no hashes at all. The WebSocket fallback needs none of it: it rides the
        same TLS chain the page itself does.
      </p>
    </footer>
  `,
  styles: `
    :host {
      display: block;
    }

    .telemetry {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
      gap: 12px 26px;
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
      font: 500 1.1rem/1.35 var(--font-data);
      overflow-wrap: anywhere;
      font-variant-numeric: tabular-nums;
    }

    .split {
      display: block;
      margin-top: 2px;
      font-size: 0.72rem;
      font-weight: 400;
      color: var(--ink-2);
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
export class ConsolePage {
  private readonly transport = inject(TransportService);

  protected readonly telemetry = computed(() => this.transport.telemetry());

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
}
