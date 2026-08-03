//! The wire protocol.
//!
//! Four logical lanes, each with its own message set:
//!
//! * **Calls** carry `Request` -> `Reply`, correlated by an id.
//! * **Push** carries `ServerPush`, server to client, for the life of a session.
//! * **Datagrams** carry `DatagramIn` / `DatagramOut`, one message each.
//! * **Upload** carries opaque bytes one way, client to server.
//!
//! Those lanes are logical, not physical. WebTransport gives each one a channel
//! of its own — a bidirectional stream per call, one server-opened
//! unidirectional stream for push, real QUIC datagrams, a client-opened
//! unidirectional stream per upload. A WebSocket has only one channel, so all
//! four share it and [`crate::lane`] says which is which.
//!
//! [`ClientFrame`] and [`ServerFrame`] are the envelope both transports use.
//! The correlation id is what a WebSocket needs to tell one in-flight call's
//! reply from another's; WebTransport could infer it from the stream, but
//! carrying it on both keeps one encoder, one decoder, one pipeline.
//!
//! `rename_all_fields = "camelCase"` keeps the JSON idiomatic for TypeScript
//! while the Rust side stays snake_case.
//!
//! Every type derives both `Serialize` and `Deserialize`: the server reads
//! `Request` and writes `Reply`, but the browser — running this same crate
//! through wasm — does the opposite, and the HTTP API accepts `Request` as
//! plain JSON.

use serde::Deserialize;
use serde::Serialize;

/// Which transport is carrying a session.
///
/// The three are not equivalent and the console says so: WebTransport's
/// datagram lane is genuinely unreliable; over a WebSocket it is emulated on a
/// reliable ordered channel and can only ever look perfect; over IPC there is
/// no wire at all — the desktop shell's webview talks to the server in the
/// same process, so even "sending" is a figure of speech.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransportKind {
    // Renamed one by one rather than with `rename_all = "camelCase"`, which
    // would produce `webTransport` — the browser API and every piece of prose
    // about it spell the protocol names in one lowercase word.
    #[serde(rename = "webtransport")]
    WebTransport,
    #[serde(rename = "websocket")]
    WebSocket,
    /// Tauri IPC, available only inside the desktop shell.
    #[serde(rename = "ipc")]
    Ipc,
}

impl TransportKind {
    /// For log lines and notices.
    pub fn label(self) -> &'static str {
        match self {
            Self::WebTransport => "WebTransport",
            Self::WebSocket => "WebSocket",
            Self::Ipc => "Tauri IPC",
        }
    }
}

/// Client -> server on the call lane.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClientFrame {
    /// One request awaiting one reply. `id` is unique within the session.
    Call { id: u64, request: Request },
}

/// Server -> client on the call and push lanes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ServerFrame {
    /// The answer to the [`ClientFrame::Call`] with the same `id`.
    Result { id: u64, reply: Reply },
    /// Nested rather than flattened: `ServerPush` is itself an internally
    /// tagged enum, and serde will not flatten one inside another. The extra
    /// level of nesting costs a few bytes and buys an unambiguous shape:
    /// `{"t":"push","push":{"kind":"telemetry",...}}`.
    Push { push: ServerPush },
}

/// Client -> server, over a bidirectional stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    /// Liveness check that also reveals the server clock.
    Ping,
    /// Send text back unchanged.
    Echo { text: String },
    /// Send text back reversed by character.
    Reverse { text: String },
    /// Burn some CPU so slow replies are visible in the client.
    Fib { n: u32 },
    /// Broadcast a line to every connected session.
    Say { author: String, text: String },
}

/// Server -> client, on the same bidirectional stream the request arrived on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Reply {
    Pong {
        server_time_ms: u64,
    },
    Echo {
        text: String,
    },
    Reversed {
        text: String,
    },
    Fib {
        n: u32,
        /// Decimal string: fib(185) overflows u128 arithmetic in decimal form.
        value: String,
        took_micros: u64,
    },
    /// The request was accepted; results arrive on the push stream.
    Accepted,
    Error {
        message: String,
    },
}

/// Server -> client, on the push lane, for the life of the session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerPush {
    /// First push of the session.
    Welcome {
        session_id: String,
        motd: String,
        /// Identifies this process run, so the client can tell a replayed log
        /// record from a fresh one after a restart resets sequence numbers.
        boot: String,
        /// Which transport the server sees this session arriving on. The client
        /// knows already; having the server say it too makes a mismatch visible
        /// rather than silent.
        transport: TransportKind,
    },
    /// Emitted once per second to every session.
    Telemetry {
        sessions: usize,
        /// The same total, split by transport, so the fallback is observable.
        sessions_webtransport: usize,
        sessions_websocket: usize,
        sessions_ipc: usize,
        bytes_in: u64,
        frames_in: u64,
        datagrams_in: u64,
        uptime_secs: u64,
    },
    /// A line broadcast by some session.
    Said {
        author: String,
        text: String,
        at_ms: u64,
    },
    /// Free-form server announcement.
    Notice { text: String },
    /// One `tracing` event from the server. Serializes flat, so the fields of
    /// `ServerLog` sit alongside `"kind": "log"`.
    Log(ServerLog),
}

/// One event captured from the server's `tracing` subscriber.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerLog {
    /// Monotonic within one process run. The client dedupes on it, because
    /// every session is sent the recent history when it connects.
    pub seq: u64,
    pub at_ms: u64,
    /// Lowercase: error, warn, info, debug, trace.
    pub level: String,
    /// The emitting module path, for example `wt_server::session`.
    pub target: String,
    pub message: String,
    /// Structured key/value pairs from the event and its enclosing spans.
    pub fields: std::collections::BTreeMap<String, String>,
    /// Which session the event belongs to, when it happened inside one.
    pub session: Option<String>,
}

/// Client -> server, one per datagram.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "d", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DatagramIn {
    /// `sent_at_ms` is the client's own `performance.now()`; the server treats it
    /// as an opaque token and returns it so the client can compute a round trip
    /// without either side needing a shared clock.
    Ping { seq: u64, sent_at_ms: f64 },
}

/// Server -> client, one per datagram.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "d", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DatagramOut {
    Pong {
        seq: u64,
        sent_at_ms: f64,
        server_time_ms: u64,
    },
}
