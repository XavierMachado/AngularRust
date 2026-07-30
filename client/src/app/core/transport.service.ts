import { computed, Injectable, signal } from '@angular/core';

import { encodeFrame, FrameDecoder } from './framing';
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
} from './protocol';
import { validateSay } from './wasm';
import { getWebTransport, type WtSession } from './webtransport.types';

/**
 * Where the server publishes its certificate fingerprint over plain HTTP.
 * Same port number as WebTransport: that one is udp/4433, this is tcp/4433.
 */
const DISCOVERY_URL = 'http://127.0.0.1:4433/discovery';

const MAX_LOG_LINES = 1000;
const MAX_ROOM_LINES = 100;
const MAX_RTT_SAMPLES = 120;
/** How long a tick stays on the ledger, in milliseconds. */
export const LEDGER_WINDOW_MS = 20_000;

export type LinkState = 'offline' | 'connecting' | 'online' | 'closing' | 'failed';

/** Which of the two transports an event used, and which way it went. */
export type Lane = 'stream' | 'datagram';
export type Direction = 'in' | 'out';

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

@Injectable({ providedIn: 'root' })
export class TransportService {
  readonly state = signal<LinkState>('offline');
  readonly detail = signal('Not connected');
  readonly sessionId = signal<string | null>(null);
  readonly motd = signal<string | null>(null);
  readonly fingerprint = signal<string | null>(null);
  readonly endpoint = signal<string | null>(null);

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

  /** Datagrams sent that never came back. */
  readonly lostDatagrams = computed(() => this.pingsSent - this.rtt().length);

  private session: WtSession | null = null;
  private datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private pingSeq = 0;
  private pingsSent = 0;
  private nextId = 1;

  /** Server log sequence numbers already shown, so replayed history doesn't duplicate. */
  private seenLogSeq = new Set<number>();
  /** Which server run those sequence numbers belong to. */
  private boot: string | null = null;

  /** Set once so the room can tell this session's own lines apart. */
  private author = '';

  async connect(author: string): Promise<void> {
    if (this.state() === 'connecting' || this.state() === 'online') {
      return;
    }

    this.author = author;

    const WebTransportCtor = getWebTransport();
    if (!WebTransportCtor) {
      this.fail('This browser has no WebTransport. Chrome or Edge 97 and up have it.');
      return;
    }

    this.state.set('connecting');
    this.detail.set('Fetching the certificate fingerprint');

    let discovery: Discovery;
    try {
      discovery = await this.fetchDiscovery();
    } catch {
      this.fail(`No answer from ${DISCOVERY_URL}. Start the server with cargo run.`);
      return;
    }

    this.fingerprint.set(discovery.certHashHex);
    this.endpoint.set(discovery.url);
    this.detail.set(`Opening a session to ${discovery.url}`);

    // The browser trusts this one certificate by fingerprint. Nothing else
    // about it changes: the session is still QUIC, still encrypted.
    const session = new WebTransportCtor(discovery.url, {
      serverCertificateHashes: [
        { algorithm: 'sha-256', value: Uint8Array.from(discovery.certHash) },
      ],
    });

    try {
      await session.ready;
    } catch (error) {
      this.fail(
        `The session was refused: ${describe(error)}. ` +
          'A stale fingerprint is the usual cause; restarting the server issues a new one.',
      );
      return;
    }

    this.session = session;
    this.state.set('online');
    this.detail.set('Session open');
    this.write('link', 'Session established');

    this.datagramWriter = session.datagrams.writable.getWriter();

    void this.readDatagrams(session);
    void this.readPushStream(session);

    void session.closed
      .then((info) => {
        this.teardown(
          info?.reason ? `Server closed the session: ${info.reason}` : 'Session closed',
        );
      })
      .catch((error: unknown) => {
        this.teardown(`Session dropped: ${describe(error)}`, 'warn');
      });
  }

  disconnect(): void {
    if (!this.session) {
      return;
    }

    this.state.set('closing');
    this.session.close({ closeCode: 0, reason: 'client finished' });
  }

  /**
   * Sends one request on its own bidirectional stream and waits for the reply.
   *
   * Each request gets a fresh stream, so a slow reply never blocks a fast one:
   * that is the whole point of stream multiplexing over a single connection.
   */
  async request(request: Request): Promise<Reply> {
    const session = this.requireSession();
    const stream = await session.createBidirectionalStream();

    this.tick('stream', 'out');

    const writer = stream.writable.getWriter();
    await writer.write(encodeFrame(request));
    await writer.close();

    const reader = stream.readable.getReader();
    const decoder = new FrameDecoder();
    const frames: Reply[] = [];

    try {
      for (;;) {
        const { value, done } = await reader.read();

        if (value) {
          frames.push(...decoder.push<Reply>(value));
        }

        if (done) {
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!frames.length) {
      throw new Error('The server closed the stream without replying');
    }

    this.tick('stream', 'in');
    return frames[0];
  }

  /** Broadcasts a line to every connected session. */
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
   * measures throughput and announces it on the push stream.
   */
  async upload(kibibytes: number): Promise<void> {
    const session = this.requireSession();
    const stream = await session.createUnidirectionalStream();
    const writer = stream.getWriter();

    const chunk = new Uint8Array(16 * 1024);
    crypto.getRandomValues(chunk);

    const total = kibibytes * 1024;
    let sent = 0;

    try {
      while (sent < total) {
        const size = Math.min(chunk.length, total - sent);

        // `write` resolves when the stream's flow control accepts more, so this
        // loop applies backpressure instead of buffering the whole payload.
        await writer.write(chunk.slice(0, size));

        sent += size;
        this.tick('stream', 'out', 0.9);
      }

      await writer.close();
      this.write('stream', `Sent ${format(total)} on one unidirectional stream`);
    } catch (error) {
      writer.abort(describe(error)).catch(() => undefined);
      throw error;
    }
  }

  /** Sends one datagram. It may never arrive, and that is not an error. */
  async ping(): Promise<void> {
    if (!this.datagramWriter) {
      throw new Error('Not connected');
    }

    const message: DatagramIn = {
      d: 'ping',
      seq: ++this.pingSeq,
      sentAtMs: performance.now(),
    };

    this.pingsSent += 1;
    await this.datagramWriter.write(new TextEncoder().encode(JSON.stringify(message)));
    this.tick('datagram', 'out', 0.5);
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

  private async fetchDiscovery(): Promise<Discovery> {
    const response = await fetch(DISCOVERY_URL, { cache: 'no-store' });

    if (!response.ok) {
      throw new Error(`Discovery returned ${response.status}`);
    }

    return (await response.json()) as Discovery;
  }

  /** Reads pongs until the session ends. */
  private async readDatagrams(session: WtSession): Promise<void> {
    const reader = session.datagrams.readable.getReader();
    const decoder = new TextDecoder();

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          return;
        }

        this.tick('datagram', 'in', 0.5);

        const message = JSON.parse(decoder.decode(value)) as DatagramOut;
        if (message.d !== 'pong') {
          continue;
        }

        const elapsed = performance.now() - message.sentAtMs;

        this.rtt.update((samples) =>
          [...samples, { seq: message.seq, ms: Math.round(elapsed * 100) / 100 }].slice(
            -MAX_RTT_SAMPLES,
          ),
        );
      }
    } catch (error) {
      if (this.state() === 'online') {
        this.write('datagram', `Datagram reader stopped: ${describe(error)}`, 'warn');
      }
    }
  }

  /**
   * Accepts the unidirectional stream the server opens and reads pushes off it
   * for the life of the session.
   */
  private async readPushStream(session: WtSession): Promise<void> {
    const streams = session.incomingUnidirectionalStreams.getReader();

    try {
      for (;;) {
        const { value, done } = await streams.read();
        if (done) {
          return;
        }

        void this.consumePushes(value);
      }
    } catch (error) {
      if (this.state() === 'online') {
        this.write('stream', `Stopped accepting streams: ${describe(error)}`, 'warn');
      }
    }
  }

  private async consumePushes(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new FrameDecoder();

    try {
      for (;;) {
        const { value, done } = await reader.read();

        if (value) {
          this.tick('stream', 'in', 0.6);

          for (const push of decoder.push<ServerPush>(value)) {
            this.applyPush(push);
          }
        }

        if (done) {
          return;
        }
      }
    } catch (error) {
      if (this.state() === 'online') {
        this.write('stream', `Push stream ended: ${describe(error)}`, 'warn');
      }
    }
  }

  private applyPush(push: ServerPush): void {
    switch (push.kind) {
      case 'welcome':
        this.sessionId.set(push.sessionId);
        this.motd.set(push.motd);

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

  private requireSession(): WtSession {
    if (!this.session || this.state() !== 'online') {
      throw new Error('Not connected');
    }

    return this.session;
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
    this.session = null;
    this.datagramWriter = null;
    this.sessionId.set(null);
    this.telemetry.set(null);
    this.state.set('offline');
    this.detail.set(reason);
    this.write('link', reason, level);
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function format(bytes: number): string {
  const units = ['B', 'KiB', 'MiB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
