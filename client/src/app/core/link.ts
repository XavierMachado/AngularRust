/**
 * What the console needs from a transport, and nothing more.
 *
 * Two implementations sit behind this: `webtransport-link.ts`, which has a
 * channel per lane, and `websocket-link.ts`, which has one channel and the lane
 * codec. `TransportService` talks only to this interface, which is what lets
 * the store, the reducers and every panel stay unaware of which one is live.
 *
 * These are plain classes rather than Angular services on purpose — they can be
 * constructed in a plain Node vitest run without a TestBed, the way the rest of
 * `core/` already is.
 */

import type {
  DatagramIn,
  DatagramOut,
  Discovery,
  LogLevel,
  Reply,
  Request,
  ServerPush,
  TransportKind,
} from './protocol';

/** Which lane an event used, and which way it went. */
export type Lane = 'stream' | 'datagram';
export type Direction = 'in' | 'out';

/**
 * How a link reports everything that is not the answer to a request.
 *
 * Callbacks rather than an observable: there is exactly one consumer, the
 * ordering has to be the arrival ordering, and the service already keeps its
 * state in signals.
 */
export interface LinkEvents {
  onPush(push: ServerPush): void;
  onPong(pong: DatagramOut): void;
  /** One mark on the ledger. */
  onTick(lane: Lane, direction: Direction, weight?: number): void;
  /** A line for the unified log, from the transport's own point of view. */
  onNote(source: string, text: string, level?: LogLevel): void;
  /** The link ended. Called once, whether cleanly or not. */
  onClosed(reason: string, level?: LogLevel): void;
}

export interface Link {
  readonly kind: TransportKind;

  /**
   * True when this transport has no datagram channel and is emulating one.
   *
   * The console reads this rather than comparing against `'websocket'`, so the
   * claim stays attached to the transport that makes it.
   */
  readonly datagramsAreEmulated: boolean;

  /** What to show in the Endpoint readout. */
  readonly endpoint: string;

  /** Resolves once the link is usable, rejects with why it is not. */
  open(discovery: Discovery, events: LinkEvents): Promise<void>;

  /** Sends one request and waits for its reply. */
  call(request: Request): Promise<Reply>;

  /** Sends one datagram. On WebTransport it may never arrive; that is the point. */
  sendDatagram(datagram: DatagramIn): Promise<void>;

  /** Streams `totalBytes` one way with no reply, applying backpressure. */
  upload(totalBytes: number): Promise<void>;

  close(): void;
}

/** Turns anything thrown into something worth putting in the log. */
export function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/** `1536` -> `1.5 KiB`. Local to the transport layer's own status lines. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
