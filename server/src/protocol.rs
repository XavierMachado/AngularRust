//! The wire protocol.
//!
//! Three separate channels, each with its own message set:
//!
//! * **Bidirectional streams** carry `Request` -> `Reply`. Reliable and ordered.
//!   Framed as `u32` big-endian length + JSON body.
//! * **A server-opened unidirectional stream** carries `ServerPush`. Same framing.
//! * **Datagrams** carry `DatagramIn` / `DatagramOut`. Unreliable, unordered,
//!   one message per datagram, so no framing is needed.
//!
//! `rename_all_fields = "camelCase"` keeps the JSON idiomatic for TypeScript
//! while the Rust side stays snake_case.

use serde::Deserialize;
use serde::Serialize;

/// Client -> server, over a bidirectional stream.
#[derive(Debug, Clone, Deserialize)]
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
#[derive(Debug, Clone, Serialize)]
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

/// Server -> client, on the long-lived unidirectional stream opened by the server.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerPush {
    /// First frame on the stream.
    Welcome {
        session_id: String,
        motd: String,
        /// Identifies this process run, so the client can tell a replayed log
        /// record from a fresh one after a restart resets sequence numbers.
        boot: String,
    },
    /// Emitted once per second to every session.
    Telemetry {
        sessions: usize,
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
#[derive(Debug, Clone, Serialize)]
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
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "d", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DatagramIn {
    /// `sent_at_ms` is the client's own `performance.now()`; the server treats it
    /// as an opaque token and returns it so the client can compute a round trip
    /// without either side needing a shared clock.
    Ping { seq: u64, sent_at_ms: f64 },
}

/// Server -> client, one per datagram.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "d", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DatagramOut {
    Pong {
        seq: u64,
        sent_at_ms: f64,
        server_time_ms: u64,
    },
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}
