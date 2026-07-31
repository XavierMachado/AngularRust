/**
 * The WebSocket link: four lanes on one channel.
 *
 * Where the WebTransport link opens a stream per call, this one tags every
 * message with a lane byte and correlates replies by id. Where WebTransport's
 * `writer.write()` resolves when flow control says so, this polls
 * `bufferedAmount`, which is the closest a socket gets.
 *
 * The datagram lane is an emulation and says so: nothing sent on it can be
 * lost or reordered, so a perfect delivery rate here means the socket worked,
 * not that the network is good.
 */

import {
  decodeLane,
  encodeControl,
  encodeDatagram,
  encodeUpload,
  encodeUploadEnd,
  LANE,
  laneJson,
} from './lane';
import { describe, formatBytes, type Link, type LinkEvents } from './link';
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
import { withDeadline } from './webtransport-link';

const CALL_TIMEOUT_MS = 30_000;
const OPEN_TIMEOUT_MS = 8_000;
const UPLOAD_CHUNK = 16 * 1024;

/**
 * How much may sit in the socket's send buffer before the upload loop waits.
 *
 * A megabyte is enough to keep the socket busy between polls without letting
 * the whole payload queue in memory, which is the failure this bound exists to
 * prevent.
 */
const HIGH_WATER = 1024 * 1024;

/** How long to wait between `bufferedAmount` polls. */
const DRAIN_POLL_MS = 4;

export class WebSocketLink implements Link {
  readonly kind: TransportKind = 'websocket';
  readonly datagramsAreEmulated = true;

  private socket: WebSocket | null = null;
  private events: LinkEvents | null = null;
  private readonly pending = new PendingCalls();
  private url = '';
  private nextUpload = 1;
  private closing = false;
  private ended = false;

  constructor(private readonly net: Net) {}

  get endpoint(): string {
    return this.url;
  }

  async open(discovery: Discovery, events: LinkEvents): Promise<void> {
    const WebSocketCtor = this.net.webSocket;
    if (!WebSocketCtor) {
      throw new Error('This browser has no WebSocket, which is a surprising place to be.');
    }

    this.events = events;
    this.url = discovery.websocketUrl;

    const socket = new WebSocketCtor(discovery.websocketUrl);
    socket.binaryType = 'arraybuffer';

    const opened = new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      // The event carries no reason — the browser withholds it deliberately,
      // so that a page cannot probe the network by watching failures.
      socket.onerror = () => reject(new Error(`could not reach ${discovery.websocketUrl}`));
    });

    await withDeadline(
      opened,
      OPEN_TIMEOUT_MS,
      `${discovery.websocketUrl} did not answer in time`,
    ).catch((error: unknown) => {
      try {
        socket.close();
      } catch {
        // Already gone.
      }

      throw new Error(describe(error));
    });

    this.socket = socket;

    socket.onmessage = (event: MessageEvent) => this.receive(event);
    socket.onerror = () => this.finish('Socket error', 'warn');
    socket.onclose = (event: CloseEvent) => {
      this.finish(
        event.reason ? `Server closed the socket: ${event.reason}` : 'Socket closed',
        this.closing || event.wasClean ? 'info' : 'warn',
      );
    };
  }

  async call(request: Request): Promise<Reply> {
    const socket = this.require();
    const { id, reply } = this.pending.open(CALL_TIMEOUT_MS);
    const frame: ClientFrame = { t: 'call', id, request };

    socket.send(encodeControl(frame));
    this.events?.onTick('stream', 'out');

    return reply;
  }

  async sendDatagram(datagram: DatagramIn): Promise<void> {
    const socket = this.require();

    socket.send(encodeDatagram(datagram));
    this.events?.onTick('datagram', 'out', 0.5);
  }

  async upload(totalBytes: number): Promise<void> {
    const socket = this.require();
    const stream = this.nextUpload++;

    const chunk = new Uint8Array(UPLOAD_CHUNK);
    crypto.getRandomValues(chunk);

    let sent = 0;

    try {
      while (sent < totalBytes) {
        // Wait before writing rather than after, so the buffer is never allowed
        // past the mark by a chunk we have already committed to.
        await this.drain(socket);

        const size = Math.min(chunk.length, totalBytes - sent);
        socket.send(encodeUpload(stream, chunk.subarray(0, size)));

        sent += size;
        this.events?.onTick('stream', 'out', 0.9);
      }

      socket.send(encodeUploadEnd(stream));
      this.events?.onNote('stream', `Sent ${formatBytes(totalBytes)} on the socket's upload lane`);
    } catch (error) {
      throw new Error(describe(error));
    }
  }

  close(): void {
    this.closing = true;
    this.socket?.close(1000, 'client finished');
  }

  private require(): WebSocket {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error('Not connected');
    }

    return this.socket;
  }

  /**
   * Waits for the send buffer to fall below the high-water mark.
   *
   * A WebSocket offers no promise to await for flow control, only a number you
   * poll — so unlike a WebTransport stream, this is an approximation. Some
   * engines only update `bufferedAmount` on a task tick, which means one extra
   * chunk can slip past the mark. Harmless at a megabyte, and the reason this
   * sleeps rather than spinning.
   */
  private async drain(socket: WebSocket): Promise<void> {
    while (socket.bufferedAmount > HIGH_WATER) {
      if (socket.readyState !== 1) {
        throw new Error('The socket closed mid-upload');
      }

      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
  }

  private receive(event: MessageEvent): void {
    if (!(event.data instanceof ArrayBuffer)) {
      // Every lane here is binary; text would mean a peer speaking something
      // else entirely.
      this.events?.onNote('stream', 'Ignoring a text message from the server', 'warn');
      return;
    }

    let decoded;
    try {
      decoded = decodeLane(new Uint8Array(event.data));
    } catch (error) {
      this.events?.onNote('stream', `Undecodable message: ${describe(error)}`, 'warn');
      return;
    }

    switch (decoded.lane) {
      case LANE.control: {
        this.events?.onTick('stream', 'in', 0.6);
        const frame = laneJson<ServerFrame>(decoded.body);

        if (frame.t === 'result') {
          this.pending.settle(frame.id, frame.reply);
        } else {
          this.events?.onPush(frame.push);
        }
        break;
      }

      case LANE.datagram: {
        this.events?.onTick('datagram', 'in', 0.5);
        const pong = laneJson<DatagramOut>(decoded.body);

        if (pong.d === 'pong') {
          this.events?.onPong(pong);
        }
        break;
      }

      default:
        // The upload lanes are client to server only.
        this.events?.onNote('stream', `Unexpected lane ${decoded.lane} from the server`, 'warn');
    }
  }

  private finish(reason: string, level: 'info' | 'warn'): void {
    if (this.ended) {
      return;
    }

    this.ended = true;
    this.socket = null;
    // A dead socket produces no per-call error, so nothing in flight would
    // ever settle without this.
    this.pending.failAll(reason);
    this.events?.onClosed(reason, level);
  }
}
