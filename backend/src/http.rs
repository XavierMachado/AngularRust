//! The TCP side of port 4433: discovery, the JSON API, the WebSocket fallback,
//! and — when a build exists — the Angular app itself.
//!
//! The API is the same business layer every session uses: `POST /api/request`
//! deserializes the identical `Request` enum and hands it to the identical
//! `app::answer`, so no transport can drift from another. A `say` posted with
//! curl lands in every connected browser's room — over WebTransport or over a
//! WebSocket, indifferently — because they all go through the same broadcast
//! bus.
//!
//! `GET /ws` is the fallback transport, for networks that block QUIC and for
//! browsers that have no WebTransport. Note that a WebSocket upgrade is *not*
//! subject to CORS; see the module docs in `ws.rs`.
//!
//! Plain HTTP, and permissive CORS, on purpose: this is the development
//! setup, where the browser must be able to fetch `/discovery` before it
//! trusts the certificate that everything else rides on. In production this
//! listener sits behind a real certificate, the CORS layer disappears, and
//! `/discovery` goes with it.

use anyhow::Context;
use anyhow::Result;
use axum::extract::State;
use axum::routing::get;
use axum::routing::post;
use axum::Json;
use axum::Router;
use serde::Serialize;
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tower_http::services::ServeFile;
use tracing::info;
use wt_shared::protocol::Reply;
use wt_shared::protocol::Request;
use wt_shared::protocol::ServerPush;
use wt_shared::protocol::TransportKind;

use crate::app;
#[cfg(feature = "datastar")]
use crate::datastar;
use crate::state::AppState;
use crate::ws;

/// Where `npm run build` puts the app, relative to the working directory.
/// Override with `STATIC_DIR`; if the directory is missing this server is
/// API-only and the Angular dev server is the front door.
const DEFAULT_STATIC_DIR: &str = "client/dist/console/browser";

/// What `GET /discovery` returns.
///
/// One fetch tells the client everything it needs to choose a transport: where
/// each one lives, which ones this server offers, and the fingerprint the
/// WebTransport handshake needs.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Discovery {
    /// Where to point `new WebTransport(...)`.
    url: String,
    /// Where to point `new WebSocket(...)` when QUIC is unavailable.
    websocket_url: String,
    /// What this server offers, best first. The client intersects this with
    /// what the browser can do and with the user's preference.
    transports: Vec<TransportKind>,
    /// SHA-256 of the DER certificate, one byte per element.
    cert_hash: Vec<u8>,
    /// The same digest as hex, for display.
    cert_hash_hex: String,
    /// Chrome's ceiling for `serverCertificateHashes`.
    max_certificate_days: u8,
}

/// The router, separated from the listener so tests can serve it on a port the
/// operating system picks.
pub fn router(state: Arc<AppState>) -> Router {
    let router = Router::new()
        .route("/discovery", get(discovery))
        .route("/health", get(health))
        .route("/telemetry", get(telemetry))
        .route("/api/request", post(api_request))
        .route("/ws", get(ws::upgrade));

    // The hypermedia console, when it was asked for: one page, one SSE
    // stream, two POSTs. Its handlers live in `client-datastar/server.rs`,
    // because they belong to that client rather than to this server; without
    // the feature there is no `/ds` and none of it is compiled in.
    #[cfg(feature = "datastar")]
    let router = {
        info!(
            "hypermedia console at /ds, from {}",
            datastar::page_dir().display()
        );

        router
            .route("/ds", get(datastar::index))
            .route("/ds/datastar.js", get(datastar::runtime))
            .route("/ds/styles.css", get(datastar::styles))
            .route("/ds/stream", get(datastar::stream))
            .route("/ds/request", post(datastar::request))
            .route("/ds/say", post(datastar::say))
    };

    let mut router = router
        .with_state(state)
        // The Angular dev server is a different origin. Development only, and
        // note it does not apply to the WebSocket upgrade above.
        .layer(CorsLayer::permissive());

    let static_dir = static_dir();
    match &static_dir {
        Some(dir) => {
            info!("serving the built client from {}", dir.display());
            router = router.fallback_service(
                ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html"))),
            );
        }
        None => info!("no client build found; API only (the dev server is the front door)"),
    }

    router
}

pub async fn serve(state: Arc<AppState>, port: u16) -> Result<()> {
    let listener = TcpListener::bind(SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port))
        .await
        .context("binding the HTTP listener")?;

    axum::serve(listener, router(state))
        .await
        .context("serving HTTP")?;

    Ok(())
}

fn static_dir() -> Option<PathBuf> {
    let dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| DEFAULT_STATIC_DIR.into());
    let dir = PathBuf::from(dir);

    dir.join("index.html").is_file().then_some(dir)
}

async fn discovery(State(state): State<Arc<AppState>>) -> Json<Discovery> {
    // Best first: WebTransport is what this lab is about, and the WebSocket is
    // what happens when it cannot be had. Advertising a QUIC endpoint that did
    // not come up would cost every client a connect deadline to discover what
    // this server already knows.
    let mut transports = Vec::with_capacity(2);
    if state.webtransport_available.load(Ordering::Relaxed) {
        transports.push(TransportKind::WebTransport);
    }
    transports.push(TransportKind::WebSocket);

    Json(Discovery {
        url: state.webtransport_url.clone(),
        websocket_url: state.websocket_url.clone(),
        transports,
        cert_hash: state.cert_hash.clone(),
        cert_hash_hex: state.cert_hash_hex.clone(),
        max_certificate_days: 14,
    })
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

/// The same numbers the push stream carries, shaped identically
/// (`{"kind":"telemetry",...}`), for anything that speaks plain HTTP.
async fn telemetry(State(state): State<Arc<AppState>>) -> Json<ServerPush> {
    Json(state.telemetry())
}

/// The third way into `app::answer`. WebTransport frames the same `Request`
/// over a stream and the WebSocket wraps it in a call envelope; this takes it
/// as a plain JSON body, unchanged from the day it was the second. `MAX_FIB`
/// guards the one expensive arm on every path, because it lives in the shared
/// crate.
async fn api_request(
    State(state): State<Arc<AppState>>,
    Json(request): Json<Request>,
) -> Json<Reply> {
    Json(app::answer(request, &state))
}
