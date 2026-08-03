import { computed, inject, Injectable, signal } from '@angular/core';

import {
  describe,
  withDeadline,
  type Direction,
  type Lane,
  type Link,
  type LinkEvents,
} from './link';
import { backoffMs, label, plan, type Preference } from './negotiate';
import { DISCOVERY_URL, NET } from './net';
import type {
  DatagramIn,
  DatagramOut,
  Discovery,
  LogLevel,
  Reply,
  Request,
  ServerLog,
  ServerPush,
  Telemetry,
  TransportKind,
} from './protocol';
import { TauriIpcLink } from './tauri-link';
import { validateSay } from './wasm';
import { WebSocketLink } from './websocket-link';
import { WebTransportLink } from './webtransport-link';

const MAX_LOG_LINES = 1000;
const MAX_ROOM_LINES = 100;
const MAX_RTT_SAMPLES = 120;
/** How long a tick stays on the ledger, in milliseconds. */
export const LEDGER_WINDOW_MS = 20_000;

/** How long to wait for the discovery endpoint before treating it as down. */
const DISCOVERY_TIMEOUT_MS = 5_000;

/** How many times to retry a dropped link before giving up on it. */
const MAX_RECONNECTS = 5;

/**
 * How many consecutive WebTransport failures before `auto` stops trying it.
 *
 * One failure can be a server restart caught mid-handshake. Two in a row, on a
 * network that has already refused it once, is the signal to stop paying the
 * deadline over and over and take the transport that works.
 */
const DOWNGRADE_AFTER = 2;

/**
 * What `plan` sees when discovery is unreachable inside the desktop shell:
 * nothing on the network side, which leaves only the in-process channel.
 */
const OFFLINE_DISCOVERY: Discovery = {
  url: '',
  websocketUrl: '',
  transports: ['ipc'],
  certHash: [],
  certHashHex: '',
  maxCertificateDays: 0,
};

export type LinkState = 'offline' | 'connecting' | 'online' | 'closing' | 'failed';

export type { Direction, Lane, Preference };

export interface LedgerTick {
  at: number;
  lane: Lane;
  direction: Direction;
  /** 0 to 1, drives the tick height. Bulk transfers draw taller. */
  weight: number;
}

/**
 * One line in the unified log. Client-side lines and forwarded server events
 * share a shape so the console can interleave them on one timeline, which is
 * the whole point: a failed request and the server's account of why sit next to
 * each other instead of in two different windows.
 */
export interface LogLine {
  id: number;
  at: number;
  origin: 'client' | 'server';
  level: LogLevel;
  /** Where it came from: a client subsystem, or a Rust module path. */
  source: string;
  text: string;
  /** Structured fields, server-side only. */
  fields?: Record<string, string>;
  /** The server session the line belongs to, when it has one. */
  session?: string | null;
}

export interface RoomLine {
  id: number;
  author: string;
  text: string;
  atMs: number;
  mine: boolean;
}

export interface RttSample {
  seq: number;
  ms: number;
}

/**
 * The console's store, and the thing that decides which transport carries it.
 *
 * Everything below the `Link` interface — streams, sockets, lanes, framing —
 * lives in `webtransport-link.ts` and `websocket-link.ts`. What is left here is
 * the state every panel reads, the reducers that maintain it, and the
 * negotiation that picks a link and keeps one alive.
 */
@Injectable({ providedIn: 'root' })
export class TransportService {
  private readonly net = inject(NET);
  private readonly discoveryUrl = inject(DISCOVERY_URL);

  /** Whether the in-process channel exists here — i.e. is this the desktop shell. */
  readonly ipcAvailable = this.net.tauriIpc !== null;

  readonly state = signal<LinkState>('offline');
  readonly detail = signal('Not connected');
  readonly sessionId = signal<string | null>(null);
  readonly motd = signal<string | null>(null);
  readonly fingerprint = signal<string | null>(null);
  readonly endpoint = signal<string | null>(null);

  /** What the user asked for. `auto` tries WebTransport and falls back. */
  readonly preference = signal<Preference>('auto');
  /** What is actually carrying the session, once one is up. */
  readonly transport = signal<TransportKind | null>(null);

  /**
   * True when the live transport has no datagram channel and is emulating one.
   *
   * The panels read this rather than comparing against `'websocket'`, so the
   * claim stays attached to the transport that makes it.
   */
  readonly datagramsEmulated = signal(false);

  readonly telemetry = signal<Telemetry | null>(null);
  readonly room = signal<RoomLine[]>([]);
  readonly log = signal<LogLine[]>([]);
  readonly rtt = signal<RttSample[]>([]);
  readonly ticks = signal<LedgerTick[]>([]);

  readonly online = computed(() => this.state() === 'online');
  readonly busy = computed(() => this.state() === 'connecting' || this.state() === 'closing');

  readonly lastRtt = computed(() => {
    const samples = this.rtt();
    return samples.length ? samples[samples.length - 1].ms : null;
  });

  readonly medianRtt = computed(() => {
    const samples = this.rtt().map((sample) => sample.ms);
    if (!samples.length) {
      return null;
    }

    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  });

  /**
   * Datagrams sent that never came back.
   *
   * `pingsSent` is a signal rather than a plain field so this recomputes when a
   * ping goes out, not only when one comes back. The moment pongs stop is
   * exactly when this number is worth reading, and a plain field froze it there.
   */
  private readonly pingsSent = signal(0);
  readonly lostDatagrams = computed(() => this.pingsSent() - this.rtt().length);

  private link: Link | null = null;
  private pingSeq = 0;
  private nextId = 1;

  /** Server log sequence numbers already shown, so replayed history doesn't duplicate. */
  private seenLogSeq = new Set<number>();
  /** Which server run those sequence numbers belong to. */
  private boot: string | null = null;

  /** Set once so the room can tell this session's own lines apart. */
  private author = '';

  /** True between `connect()` and `disconnect()`: whether to keep retrying. */
  private wanted = false;
  private reconnects = 0;
  private webTransportFailures = 0;
  private announcedDowngrade = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  async connect(author: string): Promise<void> {
    if (this.state() === 'connecting' || this.state() === 'online') {
      return;
    }

    this.author = author;
    this.wanted = true;
    this.reconnects = 0;
    this.webTransportFailures = 0;
    this.announcedDowngrade = false;

    await this.establish();
  }

  disconnect(): void {
    this.wanted = false;
    this.cancelRetry();

    if (!this.link) {
      this.state.set('offline');
      this.detail.set('Not connected');
      return;
    }

    this.state.set('closing');
    this.link.close();
  }

  /**
   * Sends one request and waits for the reply.
   *
   * On WebTransport each call gets its own stream; on a WebSocket they share
   * one channel and are told apart by a correlation id. Either way a slow reply
   * never blocks a fast one, and this method cannot tell which is happening.
   */
  async request(request: Request): Promise<Reply> {
    return this.requireLink().call(request);
  }

  /** Broadcasts a line to every connected session, on either transport. */
  async say(text: string): Promise<void> {
    // The server's own rules, run here first through wasm: what leaves this
    // tab is already trimmed the way the server would trim it, and anything
    // the server would refuse throws before it costs a round trip.
    const said = validateSay(this.author, text);
    const reply = await this.request({ op: 'say', author: said.author, text: said.text });

    if (reply.op === 'error') {
      this.write('stream', reply.message, 'warn');
    }
  }

  /**
   * Streams bytes one way with no reply, the shape of a file upload. The server
   * measures throughput and announces it to every session.
   */
  async upload(kibibytes: number): Promise<void> {
    await this.requireLink().upload(kibibytes * 1024);
  }

  /** Sends one datagram. On WebTransport it may never arrive, and that is not an error. */
  async ping(): Promise<void> {
    const link = this.requireLink();

    const message: DatagramIn = {
      d: 'ping',
      seq: ++this.pingSeq,
      sentAtMs: performance.now(),
    };

    this.pingsSent.update((sent) => sent + 1);
    await link.sendDatagram(message);
  }

  clearLog(): void {
    this.log.set([]);
  }

  /**
   * Records a line from elsewhere in the app. The global error handler uses
   * this so an uncaught exception lands on the same timeline as the transport
   * events that led to it.
   */
  note(source: string, text: string, level: LogLevel = 'info'): void {
    this.write(source, text, level);
  }

  /** Fetches discovery, then walks the negotiated order until one connects. */
  private async establish(): Promise<void> {
    this.state.set('connecting');
    this.detail.set('Asking the server what it offers');

    let discovery: Discovery;
    try {
      // On a deadline, because `fetch` has none of its own: a host that accepts
      // the connection and then says nothing would leave this awaiting forever,
      // and a retry loop that never gets to run is not a retry loop.
      discovery = await withDeadline(
        this.net.fetchJson<Discovery>(this.discoveryUrl),
        DISCOVERY_TIMEOUT_MS,
        `${this.discoveryUrl} did not answer in time`,
      );
      this.fingerprint.set(discovery.certHashHex);
    } catch {
      // Inside the desktop shell the in-process channel does not need
      // discovery at all — the server that would have answered shares this
      // process. Everywhere else, an unreachable discovery is the end.
      const preference = this.preference();

      if (this.net.tauriIpc && (preference === 'auto' || preference === 'ipc')) {
        this.write(
          'link',
          `No answer from ${this.discoveryUrl}; using the in-process channel.`,
          'warn',
        );
        discovery = OFFLINE_DISCOVERY;
      } else {
        this.fail(`No answer from ${this.discoveryUrl}. Start the server with cargo run.`);
        this.scheduleRetry();
        return;
      }
    }

    const { attempt, excluded } = plan(this.effectivePreference(), discovery, {
      webTransport: this.net.webTransport !== null,
      webSocket: this.net.webSocket !== null,
      ipc: this.net.tauriIpc !== null,
    });

    for (const reason of excluded) {
      this.write('link', reason, 'warn');
    }

    if (!attempt.length) {
      this.fail('No transport this browser and this server both support.');
      return;
    }

    for (const kind of attempt) {
      const link =
        kind === 'webtransport'
          ? new WebTransportLink(this.net)
          : kind === 'websocket'
            ? new WebSocketLink(this.net)
            : new TauriIpcLink(this.net);

      this.detail.set(`Opening a ${label(kind)} session`);

      try {
        await link.open(discovery, this.events());
      } catch (error) {
        if (kind === 'webtransport') {
          this.webTransportFailures += 1;
        }

        this.write('link', `${label(kind)} did not come up: ${describe(error)}`, 'warn');
        continue;
      }

      // Opening takes seconds, and the user may have given up during them.
      // Adopting now would leave a live session nobody asked for.
      if (!this.wanted) {
        link.close();
        return;
      }

      this.adopt(link);
      return;
    }

    // Everything on the list was tried and none of it worked.
    this.fail('Every available transport refused the connection.');
    this.scheduleRetry();
  }

  /** In `auto`, stop paying WebTransport's deadline once it has clearly failed. */
  private effectivePreference(): Preference {
    if (this.preference() === 'auto' && this.webTransportFailures >= DOWNGRADE_AFTER) {
      // Once, not on every retry: the reason is news the first time and noise
      // the next four.
      if (!this.announcedDowngrade) {
        this.announcedDowngrade = true;
        this.write(
          'link',
          'QUIC does not appear to get through here; continuing over WebSocket.',
          'warn',
        );
      }

      return 'websocket';
    }

    return this.preference();
  }

  private adopt(link: Link): void {
    this.link = link;
    this.reconnects = 0;
    this.transport.set(link.kind);
    this.datagramsEmulated.set(link.datagramsAreEmulated);
    this.endpoint.set(link.endpoint);
    this.state.set('online');
    this.detail.set(`Session open over ${label(link.kind)}`);
    this.write('link', `Session established over ${label(link.kind)}`);

    if (link.datagramsAreEmulated) {
      this.write(
        'link',
        'This transport has no datagram channel, so the datagram lane is emulated on the socket: nothing there can be lost or reordered.',
      );
    }
  }

  /** The callbacks a link reports through. One shape, used by both. */
  private events(): LinkEvents {
    return {
      onPush: (push) => this.applyPush(push),
      onPong: (pong) => this.recordRtt(pong),
      onTick: (lane, direction, weight) => this.tick(lane, direction, weight),
      onNote: (source, text, level) => this.write(source, text, level ?? 'info'),
      onClosed: (reason, level) => this.teardown(reason, level ?? 'info'),
    };
  }

  private requireLink(): Link {
    if (!this.link || this.state() !== 'online') {
      throw new Error('Not connected');
    }

    return this.link;
  }

  private recordRtt(pong: DatagramOut): void {
    const elapsed = performance.now() - pong.sentAtMs;

    this.rtt.update((samples) =>
      [...samples, { seq: pong.seq, ms: Math.round(elapsed * 100) / 100 }].slice(-MAX_RTT_SAMPLES),
    );
  }

  private applyPush(push: ServerPush): void {
    switch (push.kind) {
      case 'welcome':
        this.sessionId.set(push.sessionId);
        this.motd.set(push.motd);

        // The server's own view of which transport this is. It should always
        // agree with ours; if it ever does not, that is worth seeing.
        if (push.transport !== this.transport()) {
          this.write(
            'link',
            `The server calls this session ${push.transport}, not ${this.transport()}.`,
            'warn',
          );
        }

        // A different boot id means the server restarted and its sequence
        // numbers began again, so previously seen ones mean nothing now.
        if (push.boot !== this.boot) {
          this.boot = push.boot;
          this.seenLogSeq.clear();
        }

        this.write('link', `Server named this session ${push.sessionId}`);
        break;

      case 'telemetry':
        this.telemetry.set(push);
        break;

      case 'said':
        this.room.update((lines) =>
          [
            ...lines,
            {
              id: this.nextId++,
              author: push.author,
              text: push.text,
              atMs: push.atMs,
              mine: push.author === this.author,
            },
          ].slice(-MAX_ROOM_LINES),
        );
        break;

      case 'notice':
        this.write('stream', push.text);
        break;

      case 'log':
        this.absorb(push);
        break;
    }
  }

  /** Adds a forwarded server log record, skipping ones already shown. */
  private absorb(record: ServerLog): void {
    if (this.seenLogSeq.has(record.seq)) {
      return;
    }

    this.seenLogSeq.add(record.seq);

    this.log.update((lines) =>
      [
        ...lines,
        {
          id: this.nextId++,
          at: record.atMs,
          origin: 'server' as const,
          level: record.level,
          source: record.target,
          text: record.message,
          fields: record.fields,
          session: record.session,
        },
      ]
        .sort((left, right) => left.at - right.at)
        .slice(-MAX_LOG_LINES),
    );
  }

  private tick(lane: Lane, direction: Direction, weight = 0.7): void {
    const now = performance.now();

    this.ticks.update((ticks) => [
      ...ticks.filter((entry) => now - entry.at < LEDGER_WINDOW_MS),
      { at: now, lane, direction, weight },
    ]);
  }

  private write(source: string, text: string, level: LogLevel = 'info'): void {
    this.log.update((lines) =>
      [
        ...lines,
        { id: this.nextId++, at: Date.now(), origin: 'client' as const, level, source, text },
      ].slice(-MAX_LOG_LINES),
    );
  }

  private fail(reason: string): void {
    this.state.set('failed');
    this.detail.set(reason);
    this.write('link', reason, 'error');
  }

  private teardown(reason: string, level: LogLevel = 'info'): void {
    this.link = null;
    this.transport.set(null);
    this.datagramsEmulated.set(false);
    this.sessionId.set(null);
    this.telemetry.set(null);
    this.state.set('offline');
    this.detail.set(reason);
    this.write('link', reason, level);

    // A new session gets a new count. Carrying the old one over would report
    // the previous connection's unanswered pings against this one.
    this.pingSeq = 0;
    this.pingsSent.set(0);
    this.rtt.set([]);

    if (this.wanted) {
      this.scheduleRetry();
    }
  }

  /** Tries again after a growing pause, until the attempts run out. */
  private scheduleRetry(): void {
    if (!this.wanted || this.retryTimer) {
      return;
    }

    if (this.reconnects >= MAX_RECONNECTS) {
      this.wanted = false;
      this.fail(`Gave up after ${MAX_RECONNECTS} attempts. Press Connect to try again.`);
      return;
    }

    const wait = backoffMs(this.reconnects);
    this.reconnects += 1;

    const seconds = Math.round(wait / 100) / 10;
    this.detail.set(`Reconnecting in ${seconds}s`);
    this.write('link', `Reconnecting in ${seconds}s (attempt ${this.reconnects})`);

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;

      if (this.wanted) {
        void this.establish();
      }
    }, wait);
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
