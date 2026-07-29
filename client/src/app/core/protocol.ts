/**
 * The wire protocol, mirroring server/src/protocol.rs.
 *
 * Every message is a tagged union. The tag key differs per channel so a message
 * that arrives on the wrong one fails loudly instead of parsing by accident:
 * `op` on bidirectional streams, `kind` on the push stream, `d` on datagrams.
 */

/** Client to server, over a bidirectional stream. */
export type Request =
  | { op: 'ping' }
  | { op: 'echo'; text: string }
  | { op: 'reverse'; text: string }
  | { op: 'fib'; n: number }
  | { op: 'say'; author: string; text: string };

/** Server to client, on the stream the request arrived on. */
export type Reply =
  | { op: 'pong'; serverTimeMs: number }
  | { op: 'echo'; text: string }
  | { op: 'reversed'; text: string }
  | { op: 'fib'; n: number; value: string; tookMicros: number }
  | { op: 'accepted' }
  | { op: 'error'; message: string };

export interface Telemetry {
  kind: 'telemetry';
  sessions: number;
  bytesIn: number;
  framesIn: number;
  datagramsIn: number;
  uptimeSecs: number;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** One `tracing` event captured on the server. */
export interface ServerLog {
  /** Monotonic within one server run; the client dedupes on it. */
  seq: number;
  atMs: number;
  level: LogLevel;
  /** Emitting module path, for example `wt_server::session`. */
  target: string;
  message: string;
  /** Structured fields from the event and its enclosing spans. */
  fields: Record<string, string>;
  /** Which session the event belongs to, when it happened inside one. */
  session: string | null;
}

/** Server to client, on the long-lived unidirectional stream. */
export type ServerPush =
  | { kind: 'welcome'; sessionId: string; motd: string; boot: string }
  | Telemetry
  | { kind: 'said'; author: string; text: string; atMs: number }
  | { kind: 'notice'; text: string }
  | ({ kind: 'log' } & ServerLog);

/** Client to server, one per datagram. */
export type DatagramIn = { d: 'ping'; seq: number; sentAtMs: number };

/** Server to client, one per datagram. */
export type DatagramOut = {
  d: 'pong';
  seq: number;
  sentAtMs: number;
  serverTimeMs: number;
};

/** What the discovery endpoint returns over plain HTTP. */
export interface Discovery {
  url: string;
  certHash: number[];
  certHashHex: string;
  maxCertificateDays: number;
}
