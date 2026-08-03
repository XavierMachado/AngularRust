//! Starts the two listeners. Lives in the library rather than `main.rs` so
//! that other binaries can embed the whole server — the desktop shell in
//! `desktop/` runs exactly this beside a webview, which is what makes its
//! executable self-contained.

use anyhow::Context;
use anyhow::Result;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tracing::error;
use tracing::info;
use tracing::warn;
use wtransport::tls::Sha256DigestFmt;
use wtransport::Endpoint;
use wtransport::Identity;
use wtransport::ServerConfig;

use crate::http;
use crate::logging;
use crate::logging::LogBus;
use crate::state::AppState;
use crate::wt;

const WEBTRANSPORT_PORT: u16 = 4433;
/// Same number, different transport: the HTTP side listens on TCP, and the
/// WebSocket fallback rides that same listener.
const HTTP_PORT: u16 = 4433;

/// Brings up the whole server — logging, certificate, both listeners, the
/// telemetry ticker — and runs until a listener stops.
pub async fn run() -> Result<()> {
    // The bus exists before the subscriber does, because the subscriber writes
    // into it.
    let logs = LogBus::new();
    logging::init(logs.clone());

    // Fresh certificate per run, valid for 14 days, ECDSA P-256.
    let identity = Identity::self_signed(["localhost", "127.0.0.1", "::1"])
        .context("generating a self-signed certificate")?;

    let digest = identity.certificate_chain().as_slice()[0].hash();

    // `BytesArray` formats as `[12, 34, ...]`, which is also valid JSON.
    let cert_hash: Vec<u8> = serde_json::from_str(&digest.fmt(Sha256DigestFmt::BytesArray))
        .context("reading the certificate digest")?;
    let cert_hash_hex = cert_hash.iter().map(|byte| format!("{byte:02x}")).collect();

    let state = AppState::new(
        cert_hash,
        cert_hash_hex,
        format!("https://localhost:{WEBTRANSPORT_PORT}/lab"),
        // Plain `ws://`, for the same reason the discovery endpoint is plain
        // HTTP: the self-signed certificate the WebTransport side trusts by
        // fingerprint would fail an ordinary TLS check.
        format!("ws://127.0.0.1:{HTTP_PORT}/ws"),
        logs,
    );

    info!("certificate sha-256 {}", state.cert_hash_hex);

    let config = ServerConfig::builder()
        .with_bind_default(WEBTRANSPORT_PORT)
        // On wtransport 0.6.x this is `.with_identity(&identity)`.
        .with_identity(identity)
        .keep_alive_interval(Some(Duration::from_secs(3)))
        .build();

    // A failure here is not fatal, and making it fatal would be the wrong shape
    // for this server. The whole reason there is a WebSocket transport is that
    // QUIC is not always available; a host with no IPv6 stack, or with udp/4433
    // already taken, is the server-side version of exactly that. Refusing to
    // start would take the fallback down along with the thing it stands in for.
    let endpoint = match Endpoint::server(config) {
        Ok(endpoint) => {
            state.webtransport_available.store(true, Ordering::Relaxed);
            info!("WebTransport listening on udp/{WEBTRANSPORT_PORT}");
            Some(endpoint)
        }
        Err(error) => {
            warn!(
                %error,
                "could not bind the WebTransport endpoint; serving the WebSocket fallback only"
            );
            None
        }
    };

    spawn_telemetry(state.clone());

    info!(
        "HTTP on http://127.0.0.1:{HTTP_PORT} — /discovery, /health, /telemetry, \
         /api/request, /ws"
    );

    match endpoint {
        Some(endpoint) => {
            tokio::select! {
                result = http::serve(state.clone(), HTTP_PORT) => {
                    error!("HTTP server stopped: {result:?}");
                }
                result = wt::accept_sessions(endpoint, state.clone()) => {
                    error!("WebTransport server stopped: {result:?}");
                }
            }
        }
        None => {
            let result = http::serve(state.clone(), HTTP_PORT).await;
            error!("HTTP server stopped: {result:?}");
        }
    }

    Ok(())
}

/// One telemetry frame per second to every session, on either transport.
fn spawn_telemetry(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));

        loop {
            ticker.tick().await;
            state.publish(state.telemetry());
        }
    });
}
