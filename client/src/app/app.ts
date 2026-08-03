import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { describeTransport } from './core/negotiate';
import { TransportService } from './core/transport.service';

/**
 * The frame around every page: masthead, connection controls, readout, nav and
 * the router outlet. Living above the outlet is what keeps Connect and the
 * status pills on screen wherever the router goes — the connection belongs to
 * the app, not to a page.
 */
@Component({
  selector: 'wt-root',
  imports: [FormsModule, RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="masthead">
      <p class="eyebrow">{{ eyebrow() }}</p>

      <div class="title">
        <h1>WebTransport console</h1>

        <div class="link">
          <span class="pill" [class]="transport.state()">{{ transport.state() }}</span>

          @if (transport.transport(); as live) {
            <span class="pill" [class.emulated]="transport.datagramsEmulated()">{{ live }}</span>
          }

          @if (transport.online()) {
            <button type="button" class="ghost" (click)="transport.disconnect()">Disconnect</button>
          } @else {
            <select
              [ngModel]="transport.preference()"
              (ngModelChange)="transport.preference.set($event)"
              aria-label="Which transport to use"
              [disabled]="transport.busy()"
            >
              <option value="auto">Automatic</option>
              <option value="webtransport">WebTransport only</option>
              <option value="websocket">WebSocket only</option>
              @if (transport.ipcAvailable) {
                <option value="ipc">In-process only</option>
              }
            </select>
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

      <nav>
        <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }"
          >Console</a
        >
        <a routerLink="/log" routerLinkActive="active">Log</a>
        <a routerLink="/about" routerLinkActive="active">About</a>
      </nav>

      <dl class="readout">
        <div>
          <dt>Transport</dt>
          <dd>{{ transportLabel() }}</dd>
        </div>
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
      <router-outlet />
    </main>
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

    /* The transport pill on the fallback: dashed, the way the ledger draws an
       emulated lane, so the two read as the same claim. */
    .pill.emulated {
      border-style: dashed;
    }

    .detail {
      margin: 0 0 14px;
      color: var(--ink-2);
      font-size: 0.86rem;
    }

    nav {
      display: flex;
      gap: 4px;
      margin: 0 0 14px;
    }

    nav a {
      font: 500 0.74rem/1 var(--font-data);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--ink-2);
      text-decoration: none;
      padding: 8px 14px;
      border-radius: 999px;
      border: 1px solid transparent;
    }

    nav a:hover {
      color: var(--ink);
      border-color: var(--rule);
    }

    nav a.active {
      color: var(--reliable);
      border-color: color-mix(in srgb, var(--reliable) 45%, transparent);
      background: color-mix(in srgb, var(--reliable) 9%, var(--surface));
    }

    .readout {
      display: grid;
      gap: 12px 26px;
      margin: 0;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      padding-top: 14px;
      border-top: 1px solid var(--rule);
    }

    .readout .wide {
      grid-column: 1 / -1;
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

    .hash {
      font-size: 0.72rem;
      color: var(--ink-2);
      letter-spacing: 0.02em;
    }
  `,
})
export class App {
  protected readonly transport = inject(TransportService);
  protected readonly name = signal(suggestName());

  /**
   * The strapline stops asserting QUIC when QUIC is not what is underneath.
   * Two guarantees is a WebTransport claim; the fallback has one.
   */
  protected readonly eyebrow = computed(() => {
    switch (this.transport.transport()) {
      case 'webtransport':
        return 'QUIC · HTTP/3 · one connection, two guarantees';
      case 'websocket':
        return 'WebSocket · TCP · one connection, one guarantee';
      case 'ipc':
        return 'Tauri IPC · one process, zero wires';
      default:
        return 'QUIC when it gets through, WebSocket when it does not';
    }
  });

  protected readonly transportLabel = computed(() => {
    const live = this.transport.transport();
    return live ? describeTransport(live) : 'negotiated at connect time';
  });

  protected readonly fingerprint = computed(() => {
    const hex = this.transport.fingerprint();
    if (!hex) {
      return 'fetched from the server at connect time';
    }

    return (hex.match(/.{2}/g) ?? []).join(':');
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
