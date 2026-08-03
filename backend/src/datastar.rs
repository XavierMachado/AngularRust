//! The hypermedia console: `client-datastar/` rendered live by this server.
//!
//! The other clients hold a transport in the browser and reduce pushes into
//! their own stores. This one inverts that: the server renders HTML fragments
//! and signal patches and sends them down one SSE stream, in the wire format
//! the [Datastar](https://data-star.dev) runtime understands —
//! `datastar-merge-fragments` and `datastar-merge-signals` events, which are
//! plain `text/event-stream` lines and need no dependency to produce.
//!
//! It feeds off the same broadcast buses every session pushes through, so a
//! line said in any console lands here as a server-rendered `<li>`, and the
//! actions POST into the same [`app::answer`] business layer the transports
//! call. What this page deliberately is not: a session. It holds no link, no
//! lanes and no datagrams — that trade is the point of having it around to
//! compare.

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Instant;

use axum::extract::{Query, State};
use axum::http::header;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::Json;
use futures_util::Stream;
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;
use tracing::debug;

use wt_shared::compute::human_bytes;
use wt_shared::protocol::{Reply, Request, ServerLog, ServerPush};
use wt_shared::validate::validate_say;

use crate::app;
use crate::clock::now_ms;
use crate::logging::FORWARDING;
use crate::state::AppState;

/// Where the page's files live, relative to the working directory unless
/// `DATASTAR_DIR` says otherwise. Served from disk on purpose: edit, reload,
/// done — the stack's whole pitch is that there is no build step.
fn page_dir() -> std::path::PathBuf {
    std::env::var("DATASTAR_DIR")
        .unwrap_or_else(|_| "client-datastar".to_owned())
        .into()
}

async fn file(name: &str, content_type: &'static str) -> impl IntoResponse {
    match tokio::fs::read(page_dir().join(name)).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, content_type)], bytes).into_response(),
        Err(_) => (
            axum::http::StatusCode::NOT_FOUND,
            format!(
                "{name} not found — run the server from the repository root, or set DATASTAR_DIR"
            ),
        )
            .into_response(),
    }
}

pub async fn index() -> impl IntoResponse {
    file("index.html", "text/html; charset=utf-8").await
}

pub async fn runtime() -> impl IntoResponse {
    file("datastar.js", "text/javascript; charset=utf-8").await
}

pub async fn styles() -> impl IntoResponse {
    file("styles.css", "text/css; charset=utf-8").await
}

/// A `Stream` over a channel, so the pump task below can outlive this
/// function's borrow of the request. Hand-rolled because it is six lines,
/// which is cheaper than a crate.
pub struct Pushes(mpsc::Receiver<Event>);

impl Stream for Pushes {
    type Item = Result<Event, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.0.poll_recv(cx).map(|event| event.map(Ok))
    }
}

/// The one stream that drives the whole page.
pub async fn stream(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let (sender, receiver) = mpsc::channel::<Event>(64);

    // Subscribe before anything is sent, so nothing published in between goes
    // missing — same discipline as `session::push_events`.
    let mut events = state.events.subscribe();
    let mut logs = state.logs.subscribe();

    let task = async move {
        // The page learns it is live, and gets a telemetry snapshot without
        // waiting for the next tick.
        let _ = sender.send(signals(&state, true)).await;

        // Replay recent history so the log has substance on arrival.
        for record in state.logs.history() {
            if sender.send(log_line(&record)).await.is_err() {
                return;
            }
        }

        loop {
            let event = tokio::select! {
                event = events.recv() => match event {
                    Ok(push) => render(&state, push),
                    Err(RecvError::Lagged(_)) => Some(note("this viewer fell behind the broadcast")),
                    Err(RecvError::Closed) => return,
                },
                record = logs.recv() => match record {
                    Ok(record) => Some(log_line(&record)),
                    Err(RecvError::Lagged(_)) => Some(note("log records dropped on the way here")),
                    Err(RecvError::Closed) => return,
                },
            };

            if let Some(event) = event {
                if sender.send(event).await.is_err() {
                    // The viewer navigated away; the pump ends with it.
                    return;
                }
            }
        }
    };

    // Log forwarding must not observe this task, or forwarding a record would
    // log a record about forwarding it — the same loop the sessions guard
    // against.
    tokio::spawn(FORWARDING.scope((), task));

    debug!("hypermedia viewer connected");
    Sse::new(Pushes(receiver)).keep_alive(KeepAlive::default())
}

/// One push, rendered for the page — or nothing, when it is not the page's
/// business.
fn render(state: &Arc<AppState>, push: ServerPush) -> Option<Event> {
    match push {
        ServerPush::Telemetry { .. } => Some(signals(state, true)),

        ServerPush::Said {
            author,
            text,
            at_ms,
        } => Some(fragments(
            "#room-lines",
            "append",
            &format!(
                r#"<li><span class="who">{}</span><span class="what">{}</span><time>{}</time></li>"#,
                escape(&author),
                escape(&text),
                clock(at_ms),
            ),
        )),

        ServerPush::Notice { text } => Some(fragments(
            "#log-lines",
            "append",
            &format!(
                r#"<li class="info"><time>{}</time><span class="level">info</span><span class="source">stream</span><span class="text">{}</span></li>"#,
                clock(now_ms()),
                escape(&text),
            ),
        )),

        ServerPush::Log(record) => Some(log_line(&record)),

        // Welcomes belong to sessions, and this page is not one.
        ServerPush::Welcome { .. } => None,
    }
}

fn log_line(record: &ServerLog) -> Event {
    let source = record
        .target
        .strip_prefix("wt_server::")
        .unwrap_or(&record.target);

    fragments(
        "#log-lines",
        "append",
        &format!(
            r#"<li class="{}"><time>{}</time><span class="level">{}</span><span class="source">{}</span><span class="text">{}</span></li>"#,
            record.level,
            clock(record.at_ms),
            record.level,
            escape(source),
            escape(&record.message),
        ),
    )
}

fn note(text: &str) -> Event {
    fragments(
        "#log-lines",
        "append",
        &format!(
            r#"<li class="warn"><time>{}</time><span class="level">warn</span><span class="source">stream</span><span class="text">{}</span></li>"#,
            clock(now_ms()),
            escape(text),
        ),
    )
}

/// The telemetry strip, as a Datastar signals patch. The values arrive
/// preformatted because formatting is the server's job on this page.
fn signals(state: &Arc<AppState>, connected: bool) -> Event {
    let uptime = state.telemetry();
    let ServerPush::Telemetry {
        sessions,
        sessions_webtransport,
        sessions_websocket,
        sessions_ipc,
        bytes_in,
        frames_in,
        datagrams_in,
        uptime_secs,
    } = uptime
    else {
        unreachable!("state.telemetry() returns telemetry");
    };

    let patch = serde_json::json!({
        "connected": connected,
        "sessions": sessions,
        "wt": sessions_webtransport,
        "ws": sessions_websocket,
        "ipc": sessions_ipc,
        "framesIn": frames_in,
        "datagramsIn": datagrams_in,
        "bytesIn": human_bytes(bytes_in),
        "uptime": format!("{}m {:02}s", uptime_secs / 60, uptime_secs % 60),
    });

    Event::default()
        .event("datastar-merge-signals")
        .data(format!("signals {patch}"))
}

/// A `datastar-merge-fragments` event. The multi-line `data:` framing is
/// SSE's own; each line's `selector` / `mergeMode` / `fragments` prefix is
/// Datastar's.
fn fragments(selector: &str, merge_mode: &str, html: &str) -> Event {
    Event::default()
        .event("datastar-merge-fragments")
        .data(format!(
            "selector {selector}\nmergeMode {merge_mode}\nfragments {html}"
        ))
}

/// One-shot SSE bodies for the action endpoints: Datastar reads the patches
/// out of the response the same way it reads the long stream.
fn one_shot(
    events: Vec<Event>,
) -> Sse<futures_util::stream::Iter<std::vec::IntoIter<Result<Event, Infallible>>>> {
    let events: Vec<Result<Event, Infallible>> = events.into_iter().map(Ok).collect();
    Sse::new(futures_util::stream::iter(events))
}

/// What the page binds: every signal comes back on every POST, and each
/// handler picks what it needs.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSignals {
    #[serde(default)]
    text: String,
    #[serde(default)]
    n: serde_json::Value,
    #[serde(default)]
    author: String,
    #[serde(default)]
    draft: String,
}

#[derive(Deserialize)]
pub struct Op {
    op: String,
}

/// The request panel's four buttons, answered by the same business layer the
/// transports call — with the round trip measured where this page measures
/// everything, on the server.
pub async fn request(
    State(state): State<Arc<AppState>>,
    Query(Op { op }): Query<Op>,
    Json(signals_in): Json<PageSignals>,
) -> impl IntoResponse {
    // Number inputs bind as strings or numbers depending on the browser;
    // take either.
    let n = signals_in
        .n
        .as_u64()
        .or_else(|| signals_in.n.as_str().and_then(|value| value.parse().ok()))
        .unwrap_or(0) as u32;

    let request = match op.as_str() {
        "echo" => Request::Echo {
            text: signals_in.text,
        },
        "reverse" => Request::Reverse {
            text: signals_in.text,
        },
        "fib" => Request::Fib { n },
        _ => Request::Ping,
    };

    state.frames_in.fetch_add(1, Ordering::Relaxed);

    let started = Instant::now();
    let reply = app::answer(request, &state);
    let took = started.elapsed().as_micros().max(1);

    let body = match reply {
        Reply::Pong { server_time_ms } => format!("server clock {}", clock(server_time_ms)),
        Reply::Echo { text } => escape(&text),
        Reply::Reversed { text } => escape(&text),
        Reply::Fib {
            n,
            value,
            took_micros,
        } => {
            format!("fib({n}) = {value}   ·   {took_micros} µs to compute")
        }
        Reply::Accepted => "accepted".to_owned(),
        Reply::Error { message } => escape(&message),
    };

    one_shot(vec![fragments(
        "#reply",
        "inner",
        &format!("<code>{body}   ·   {took} µs handled, measured on the server</code>"),
    )])
}

/// The room's send button: the shared validation, then the same broadcast the
/// sessions publish through — which is how a line said here lands in every
/// console, SPAs included.
pub async fn say(
    State(state): State<Arc<AppState>>,
    Json(signals_in): Json<PageSignals>,
) -> impl IntoResponse {
    match validate_say(&signals_in.author, &signals_in.draft) {
        Ok(message) => {
            state.publish(ServerPush::Said {
                author: message.author,
                text: message.text,
                at_ms: now_ms(),
            });

            one_shot(vec![
                Event::default()
                    .event("datastar-merge-signals")
                    .data(r#"signals {"draft":""}"#),
                fragments("#say-note", "inner", ""),
            ])
        }
        Err(reason) => one_shot(vec![fragments("#say-note", "inner", &escape(&reason))]),
    }
}

/// `HH:MM:SS` in UTC from unix milliseconds. The clients format times in the
/// browser's zone; this page's clock belongs to the server, so it says so.
fn clock(at_ms: u64) -> String {
    let seconds = (at_ms / 1000) % 86_400;
    format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        (seconds / 60) % 60,
        seconds % 60
    )
}

/// Minimal HTML escaping for text that goes into fragments. Everything
/// user-written passes through here before it is markup.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
