//! A WebTransport server with a plain-HTTP side on the same port number.
//!
//! Port 4433/udp  WebTransport over HTTP/3
//! Port 4433/tcp  `GET /discovery`, which hands the browser the certificate
//!                fingerprint it needs to trust this server
//!
//! TCP and UDP are separate port namespaces, so both listeners bind 4433 in one
//! process without conflict — the same way DNS holds 53 on both.
//!
//! Why the side-channel: a browser will only open a WebTransport session to a
//! server it trusts. In development there is no public CA, so the client passes
//! `serverCertificateHashes` instead. Chrome accepts that only for an ECDSA
//! P-256 certificate valid for at most 14 days, which is exactly what
//! `Identity::self_signed` produces. The fingerprint changes on every restart,
//! so the client fetches it at connect time rather than having it pasted in.

mod clock;
mod framing;
mod logging;
mod session;
mod state;

use anyhow::Context;
use anyhow::Result;
use axum::routing::get;
use axum::Json;
use axum::Router;
use serde::Serialize;
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;
use tracing::error;
use tracing::info;
use tracing::info_span;
use tracing::Instrument;
use wtransport::endpoint::endpoint_side::Server;
use wtransport::tls::Sha256DigestFmt;
use wtransport::Endpoint;
use wtransport::Identity;
use wtransport::ServerConfig;

use crate::logging::LogBus;
use crate::state::AppState;

const WEBTRANSPORT_PORT: u16 = 4433;
/// Same number, different transport: the HTTP side listens on TCP.
const HTTP_PORT: u16 = 4433;

/// What `GET /discovery` returns.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Discovery {
    /// Where to point `new WebTransport(...)`.
    url: String,
    /// SHA-256 of the DER certificate, one byte per element.
    cert_hash: Vec<u8>,
    /// The same digest as hex, for display.
    cert_hash_hex: String,
    /// Chrome's ceiling for `serverCertificateHashes`.
    max_certificate_days: u8,
}

#[tokio::main]
async fn main() -> Result<()> {
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
        logs,
    );

    info!("certificate sha-256 {}", state.cert_hash_hex);

    let config = ServerConfig::builder()
        .with_bind_default(WEBTRANSPORT_PORT)
        // On wtransport 0.6.x this is `.with_identity(&identity)`.
        .with_identity(identity)
        .keep_alive_interval(Some(Duration::from_secs(3)))
        .build();

    let endpoint = Endpoint::server(config).context("binding the WebTransport endpoint")?;

    spawn_telemetry(state.clone());

    info!("WebTransport listening on udp/{WEBTRANSPORT_PORT}");
    info!("discovery on http://127.0.0.1:{HTTP_PORT}/discovery");

    tokio::select! {
        result = serve_discovery(state.clone()) => {
            error!("discovery server stopped: {result:?}");
        }
        result = accept_sessions(endpoint, state.clone()) => {
            error!("WebTransport server stopped: {result:?}");
        }
    }

    Ok(())
}

/// Accepts sessions forever, one task each.
async fn accept_sessions(endpoint: Endpoint<Server>, state: Arc<AppState>) -> Result<()> {
    for id in 0u64.. {
        let incoming = endpoint.accept().await;
        let state = state.clone();
        let session_id = format!("s{id:03}");

        // The span's `id` field is what tags every log record from this session,
        // so the console can filter by it.
        let span = info_span!("session", id = %session_id);

        tokio::spawn(
            async move {
                if let Err(error) = session::handle(incoming, state, session_id).await {
                    info!("session closed: {error}");
                }
            }
            .instrument(span),
        );
    }

    Ok(())
}

/// One telemetry frame per second to every session.
fn spawn_telemetry(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));

        loop {
            ticker.tick().await;
            state.publish(state.telemetry());
        }
    });
}

async fn serve_discovery(state: Arc<AppState>) -> Result<()> {
    let handler = {
        let state = state.clone();

        move || {
            let state = state.clone();

            async move {
                Json(Discovery {
                    url: state.webtransport_url.clone(),
                    cert_hash: state.cert_hash.clone(),
                    cert_hash_hex: state.cert_hash_hex.clone(),
                    max_certificate_days: 14,
                })
            }
        }
    };

    let router = Router::new()
        .route("/discovery", get(handler))
        // The Angular dev server is a different origin, so this needs CORS.
        // Development only.
        .layer(CorsLayer::permissive());

    let listener = TcpListener::bind(SocketAddr::new(Ipv4Addr::LOCALHOST.into(), HTTP_PORT))
        .await
        .context("binding the discovery listener")?;

    axum::serve(listener, router)
        .await
        .context("serving discovery")?;

    Ok(())
}
