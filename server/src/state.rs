//! State shared by every session.

use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::broadcast;

use crate::logging::LogBus;
use crate::protocol::ServerPush;

/// How many pushes a slow session may fall behind before it starts losing them.
const BROADCAST_DEPTH: usize = 256;

pub struct AppState {
    /// SHA-256 of the DER certificate, as raw bytes for the browser.
    pub cert_hash: Vec<u8>,
    /// The same digest as lowercase hex, for humans and logs.
    pub cert_hash_hex: String,
    pub webtransport_url: String,

    pub sessions: AtomicUsize,
    pub bytes_in: AtomicU64,
    pub frames_in: AtomicU64,
    pub datagrams_in: AtomicU64,
    started: Instant,

    /// Fan-out bus. Every session subscribes and forwards to its own push stream.
    pub events: broadcast::Sender<ServerPush>,
    /// The server's own `tracing` output, on its way to the browser.
    pub logs: Arc<LogBus>,
}

impl AppState {
    pub fn new(
        cert_hash: Vec<u8>,
        cert_hash_hex: String,
        webtransport_url: String,
        logs: Arc<LogBus>,
    ) -> Arc<Self> {
        let (events, _) = broadcast::channel(BROADCAST_DEPTH);

        Arc::new(Self {
            cert_hash,
            cert_hash_hex,
            webtransport_url,
            sessions: AtomicUsize::new(0),
            bytes_in: AtomicU64::new(0),
            frames_in: AtomicU64::new(0),
            datagrams_in: AtomicU64::new(0),
            started: Instant::now(),
            events,
            logs,
        })
    }

    pub fn telemetry(&self) -> ServerPush {
        ServerPush::Telemetry {
            sessions: self.sessions.load(Ordering::Relaxed),
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
}

/// Keeps the session count honest even when a session ends by error or panic.
pub struct SessionGuard(Arc<AppState>);

impl SessionGuard {
    pub fn enter(state: Arc<AppState>) -> Self {
        state.sessions.fetch_add(1, Ordering::Relaxed);
        Self(state)
    }
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.0.sessions.fetch_sub(1, Ordering::Relaxed);
    }
}
