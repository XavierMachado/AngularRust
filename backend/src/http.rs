//! The TCP side of port 4433: discovery, the JSON API, and — when a build
//! exists — the Angular app itself.
//!
//! The API is the same business layer the WebTransport sessions use:
//! `POST /api/request` deserializes the identical `Request` enum and hands it
//! to the identical `session::answer`, so the two transports cannot drift.
//! A `say` posted with curl lands in every connected browser's room, because
//! it goes through the same broadcast bus.
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
use std::sync::Arc;
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tower_http::services::ServeFile;
use tracing::info;
use wt_shared::protocol::Reply;
use wt_shared::protocol::Request;
use wt_shared::protocol::ServerPush;

use crate::session;
use crate::state::AppState;

/// Where `npm run build` puts the app, relative to the working directory.
/// Override with `STATIC_DIR`; if the directory is missing this server is
/// API-only and the Angular dev server is the front door.
const DEFAULT_STATIC_DIR: &str = "client/dist/console/browser";

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

pub async fn serve(state: Arc<AppState>, port: u16) -> Result<()> {
    let mut router = Router::new()
        .route("/discovery", get(discovery))
        .route("/health", get(health))
        .route("/telemetry", get(telemetry))
        .route("/api/request", post(api_request))
        .with_state(state)
        // The Angular dev server is a different origin. Development only.
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

    let listener = TcpListener::bind(SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port))
        .await
        .context("binding the HTTP listener")?;

    axum::serve(listener, router)
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
    Json(Discovery {
        url: state.webtransport_url.clone(),
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

/// The second transport into `session::answer`. WebTransport frames the same
/// `Request` over a stream; this takes it as a JSON body. `MAX_FIB` guards the
/// one expensive arm on both paths, because it lives in the shared crate.
async fn api_request(
    State(state): State<Arc<AppState>>,
    Json(request): Json<Request>,
) -> Json<Reply> {
    Json(session::answer(request, &state))
}
