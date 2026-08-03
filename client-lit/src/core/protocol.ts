/**
 * The wire protocol, mirroring shared/src/protocol.rs.
 *
 * Every message is a tagged union. The tag key differs per lane so a message
 * that arrives on the wrong one fails loudly instead of parsing by accident:
 * `op` on calls, `kind` on pushes, `d` on datagrams, `t` on the envelope that
 * wraps the first two.
 *
 * The lanes are logical. WebTransport gives each one a channel of its own; a
 * WebSocket carries all of them on its single channel, told apart by the lane
 * byte in `lane.ts`.
 */

/** Which transport is carrying the session. `ipc` exists only in the desktop shell. */
export type TransportKind = 'webtransport' | 'websocket' | 'ipc';

/** Client to server on the call lane. */
export type ClientFrame = { t: 'call'; id: number; request: Request };

/** Server to client on the call and push lanes. */
export type ServerFrame =
  { t: 'result'; id: number; reply: Reply } | { t: 'push'; push: ServerPush };

/** Client to server, one call. */
export type Request =
  | { op: 'ping' }
  | { op: 'echo'; text: string }
  | { op: 'reverse'; text: string }
  | { op: 'fib'; n: number }
  | { op: 'say'; author: string; text: string };

/** Server to client, answering the call with the same id. */
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
  /** The same total, split by transport, so the fallback is observable. */
  sessionsWebtransport: number;
  sessionsWebsocket: number;
  sessionsIpc: number;
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

/** Server to client, on the push lane, for the life of the session. */
export type ServerPush =
  | {
      kind: 'welcome';
      sessionId: string;
      motd: string;
      boot: string;
      /** What the server thinks it gave us. A mismatch is worth seeing. */
      transport: TransportKind;
    }
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

/**
 * What the discovery endpoint returns over plain HTTP.
 *
 * One fetch is enough to negotiate: it says where each transport lives and
 * which ones this server offers, best first.
 */
export interface Discovery {
  url: string;
  websocketUrl: string;
  transports: TransportKind[];
  certHash: number[];
  certHashHex: string;
  maxCertificateDays: number;
}
