/**
 * The WebTransport link: a channel per lane.
 *
 * Each call gets a fresh bidirectional stream, so a slow reply never blocks a
 * fast one — that is the whole point of stream multiplexing over one
 * connection. Bulk upload gets a unidirectional stream of its own, pushes
 * arrive on one the server opens, and datagrams are datagrams: unreliable,
 * unordered, and a missing pong is the transport working as designed.
 */

import { encodeFrame, FrameDecoder } from './framing';
import { describe, formatBytes, withDeadline, type Link, type LinkEvents } from './link';
import type { Net } from './net';
import { PendingCalls } from './pending';
import type {
  ClientFrame,
  DatagramIn,
  DatagramOut,
  Discovery,
  Reply,
  Request,
  ServerFrame,
  TransportKind,
} from './protocol';
import type { WtSession } from './webtransport.types';

/** How long to wait for a reply before giving up on it. */
const CALL_TIMEOUT_MS = 30_000;

/**
 * How long to wait for the session to come up.
 *
 * On a network that drops UDP, `ready` does not reject — it hangs, sometimes
 * for a minute. That silence is the exact condition the fallback exists for, so
 * this deadline is not a safety net; it is the trigger.
 */
export const READY_TIMEOUT_MS = 4_000;

const UPLOAD_CHUNK = 16 * 1024;

export class WebTransportLink implements Link {
  readonly kind: TransportKind = 'webtransport';
  readonly datagramsAreEmulated = false;

  private session: WtSession | null = null;
  private datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private events: LinkEvents | null = null;
  private readonly pending = new PendingCalls();
  private url = '';
  private closing = false;

  constructor(private readonly net: Net) {}

  get endpoint(): string {
    return this.url;
  }

  async open(discovery: Discovery, events: LinkEvents): Promise<void> {
    const WebTransportCtor = this.net.webTransport;
    if (!WebTransportCtor) {
      throw new Error('This browser has no WebTransport. Chrome or Edge 97 and up have it.');
    }

    this.events = events;
    this.url = discovery.url;

    // The browser trusts this one certificate by fingerprint. Nothing else
    // about it changes: the session is still QUIC, still encrypted.
    const session = new WebTransportCtor(discovery.url, {
      serverCertificateHashes: [
        { algorithm: 'sha-256', value: Uint8Array.from(discovery.certHash) },
      ],
    });

    await withDeadline(
      session.ready,
      READY_TIMEOUT_MS,
      'the session did not come up in time, which is what a network that drops UDP looks like',
    ).catch((error: unknown) => {
      // Leaving a half-open session behind would keep retrying underneath us.
      try {
        session.close();
      } catch {
        // Already gone.
      }

      throw new Error(describe(error));
    });

    this.session = session;
    this.datagramWriter = session.datagrams.writable.getWriter();

    void this.readDatagrams(session);
    void this.readPushStreams(session);

    void session.closed
      .then((info) => {
        this.ended(info?.reason ? `Server closed the session: ${info.reason}` : 'Session closed');
      })
      .catch((error: unknown) => {
        this.ended(`Session dropped: ${describe(error)}`, 'warn');
      });
  }

  async call(request: Request): Promise<Reply> {
    const session = this.require();
    const { id, reply } = this.pending.open(CALL_TIMEOUT_MS);

    try {
      const stream = await session.createBidirectionalStream();

      this.events?.onTick('stream', 'out');

      const frame: ClientFrame = { t: 'call', id, request };
      const writer = stream.writable.getWriter();
      await writer.write(encodeFrame(frame));
      await writer.close();

      // The reply comes back on the stream it went out on, so this link settles
      // its own pending call rather than waiting for a dispatcher.
      void this.readReplies(id, stream.readable);
    } catch (error) {
      // The call never left. Retire the entry rather than leaving it to time
      // out in half a minute: nobody is holding `reply`, so its rejection would
      // surface later as an unhandled one, long after the real error was shown.
      this.pending.fail(id, describe(error));
    }

    return reply;
  }

  async sendDatagram(datagram: DatagramIn): Promise<void> {
    if (!this.datagramWriter) {
      throw new Error('Not connected');
    }

    await this.datagramWriter.write(new TextEncoder().encode(JSON.stringify(datagram)));
    this.events?.onTick('datagram', 'out', 0.5);
  }

  async upload(totalBytes: number): Promise<void> {
    const session = this.require();
    const stream = await session.createUnidirectionalStream();
    const writer = stream.getWriter();

    const chunk = new Uint8Array(UPLOAD_CHUNK);
    crypto.getRandomValues(chunk);

    let sent = 0;

    try {
      while (sent < totalBytes) {
        const size = Math.min(chunk.length, totalBytes - sent);

        // `write` resolves when the stream's flow control accepts more, so this
        // loop applies backpressure instead of buffering the whole payload.
        await writer.write(chunk.slice(0, size));

        sent += size;
        this.events?.onTick('stream', 'out', 0.9);
      }

      await writer.close();
      this.events?.onNote('stream', `Sent ${formatBytes(totalBytes)} on one unidirectional stream`);
    } catch (error) {
      writer.abort(describe(error)).catch(() => undefined);
      throw error;
    }
  }

  close(): void {
    this.closing = true;
    this.session?.close({ closeCode: 0, reason: 'client finished' });
  }

  private require(): WtSession {
    if (!this.session) {
      throw new Error('Not connected');
    }

    return this.session;
  }

  /** Drains one reply stream to EOF and settles the call it belongs to. */
  private async readReplies(id: number, readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();
    const decoder = new FrameDecoder();
    let answered = false;

    try {
      for (;;) {
        const { value, done } = await reader.read();

        if (value) {
          for (const frame of decoder.push<ServerFrame>(value)) {
            if (frame.t === 'result') {
              this.events?.onTick('stream', 'in');
              this.pending.settle(frame.id, frame.reply);
              answered = true;
            }
          }
        }

        if (done) {
          break;
        }
      }
    } catch (error) {
      this.events?.onNote('stream', `Reply stream failed: ${describe(error)}`, 'warn');
    } finally {
      reader.releaseLock();
    }

    if (!answered) {
      // EOF with nothing on it. WebTransport can prove that, where a socket
      // cannot — but it proves it about *this* call only. Every other call is
      // on a stream of its own and is still perfectly alive.
      this.pending.fail(id, 'The server closed the stream without replying');
    }
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

        this.events?.onTick('datagram', 'in', 0.5);

        const message = JSON.parse(decoder.decode(value)) as DatagramOut;
        if (message.d === 'pong') {
          this.events?.onPong(message);
        }
      }
    } catch (error) {
      if (!this.closing) {
        this.events?.onNote('datagram', `Datagram reader stopped: ${describe(error)}`, 'warn');
      }
    }
  }

  /** Accepts the unidirectional stream the server opens and reads pushes off it. */
  private async readPushStreams(session: WtSession): Promise<void> {
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
      if (!this.closing) {
        this.events?.onNote('stream', `Stopped accepting streams: ${describe(error)}`, 'warn');
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
          this.events?.onTick('stream', 'in', 0.6);

          for (const frame of decoder.push<ServerFrame>(value)) {
            if (frame.t === 'push') {
              this.events?.onPush(frame.push);
            }
          }
        }

        if (done) {
          return;
        }
      }
    } catch (error) {
      if (!this.closing) {
        this.events?.onNote('stream', `Push stream ended: ${describe(error)}`, 'warn');
      }
    }
  }

  private ended(reason: string, level: 'info' | 'warn' = 'info'): void {
    this.session = null;
    this.datagramWriter = null;
    this.pending.failAll(reason);
    this.events?.onClosed(reason, level);
  }
}
