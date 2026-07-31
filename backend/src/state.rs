//! State shared by every session.

use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::broadcast;

use wt_shared::protocol::ServerPush;
use wt_shared::protocol::TransportKind;

use crate::logging::LogBus;

/// How many pushes a slow session may fall behind before it starts losing them.
const BROADCAST_DEPTH: usize = 256;

pub struct AppState {
    /// SHA-256 of the DER certificate, as raw bytes for the browser.
    pub cert_hash: Vec<u8>,
    /// The same digest as lowercase hex, for humans and logs.
    pub cert_hash_hex: String,
    pub webtransport_url: String,
    pub websocket_url: String,

    /// Whether the QUIC endpoint actually came up. When it did not — no IPv6
    /// stack, udp/4433 already taken — discovery stops advertising a transport
    /// that cannot work, so the client falls straight through to the WebSocket
    /// instead of paying a connect deadline to learn the same thing.
    pub webtransport_available: AtomicBool,

    pub sessions: AtomicUsize,
    /// The same total, split by transport, so the fallback is observable rather
    /// than merely believed in.
    pub webtransport_sessions: AtomicUsize,
    pub websocket_sessions: AtomicUsize,

    pub bytes_in: AtomicU64,
    pub frames_in: AtomicU64,
    pub datagrams_in: AtomicU64,
    started: Instant,

    /// One namespace for both transports, so `s003` in a log filter still means
    /// exactly one connection.
    next_session: AtomicU64,

    /// Fan-out bus. Every session subscribes and forwards to its own push lane.
    pub events: broadcast::Sender<ServerPush>,
    /// The server's own `tracing` output, on its way to the browser.
    pub logs: Arc<LogBus>,
}

impl AppState {
    pub fn new(
        cert_hash: Vec<u8>,
        cert_hash_hex: String,
        webtransport_url: String,
        websocket_url: String,
        logs: Arc<LogBus>,
    ) -> Arc<Self> {
        let (events, _) = broadcast::channel(BROADCAST_DEPTH);

        Arc::new(Self {
            cert_hash,
            cert_hash_hex,
            webtransport_url,
            websocket_url,
            webtransport_available: AtomicBool::new(false),
            sessions: AtomicUsize::new(0),
            webtransport_sessions: AtomicUsize::new(0),
            websocket_sessions: AtomicUsize::new(0),
            bytes_in: AtomicU64::new(0),
            frames_in: AtomicU64::new(0),
            datagrams_in: AtomicU64::new(0),
            started: Instant::now(),
            next_session: AtomicU64::new(0),
            events,
            logs,
        })
    }

    /// The next session id, drawn from the counter both transports share.
    pub fn mint_session_id(&self) -> String {
        format!("s{:03}", self.next_session.fetch_add(1, Ordering::Relaxed))
    }

    pub fn telemetry(&self) -> ServerPush {
        ServerPush::Telemetry {
            sessions: self.sessions.load(Ordering::Relaxed),
            sessions_webtransport: self.webtransport_sessions.load(Ordering::Relaxed),
            sessions_websocket: self.websocket_sessions.load(Ordering::Relaxed),
            bytes_in: self.bytes_in.load(Ordering::Relaxed),
            frames_in: self.frames_in.load(Ordering::Relaxed),
            datagrams_in: self.datagrams_in.load(Ordering::Relaxed),
            uptime_secs: self.started.elapsed().as_secs(),
        }
    }

    /// Publishes an event. Failure just means nobody is listening.
    pub fn publish(&self, event: ServerPush) {
        let _ = self.events.send(event);
    }

    fn counter(&self, transport: TransportKind) -> &AtomicUsize {
        match transport {
            TransportKind::WebTransport => &self.webtransport_sessions,
            TransportKind::WebSocket => &self.websocket_sessions,
        }
    }
}

/// Keeps the session counts honest even when a session ends by error or panic.
pub struct SessionGuard(Arc<AppState>, TransportKind);

impl SessionGuard {
    pub fn enter(state: Arc<AppState>, transport: TransportKind) -> Self {
        state.sessions.fetch_add(1, Ordering::Relaxed);
        state.counter(transport).fetch_add(1, Ordering::Relaxed);
        Self(state, transport)
    }
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.0.sessions.fetch_sub(1, Ordering::Relaxed);
        self.0.counter(self.1).fetch_sub(1, Ordering::Relaxed);
    }
}
