//! Everything that happens inside one session, on either transport.
//!
//! There is no QUIC and no TCP in this module — only a [`Link`], which is a
//! channel in, a channel out, and a label saying what is underneath. That is
//! the whole point: request handling, upload accounting, ping and pong, the
//! welcome, telemetry, replayed history and lag notices are written once, and
//! the two adapters differ only in how bytes become [`Inbound`] and how
//! [`Outbound`] becomes bytes.
//!
//! Two concurrent jobs, as before:
//!
//! 1. [`pump`] drains the inbound channel and answers.
//! 2. [`push_events`] follows the broadcast buses and pushes what they carry.

use anyhow::Result;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;
use tracing::debug;
use tracing::warn;

use wt_shared::protocol::DatagramIn;
use wt_shared::protocol::DatagramOut;
use wt_shared::protocol::ServerPush;

use crate::app;
use crate::clock::now_ms;
use crate::link::carried_on;
use crate::link::motd;
use crate::link::Inbound;
use crate::link::Link;
use crate::link::LinkSender;
use crate::logging::FORWARDING;
use crate::state::AppState;
use crate::state::SessionGuard;

/// A client may not open more than this many uploads at once. Without a bound,
/// a peer that sends chunks under ever-increasing ids grows the map forever.
const MAX_OPEN_UPLOADS: usize = 8;

/// Runs one session to its end. Returns when the transport drops.
pub async fn run(link: Link, state: Arc<AppState>, session_id: String) -> Result<()> {
    let kind = link.kind;
    let _guard = SessionGuard::enter(state.clone(), kind);

    state.publish(ServerPush::Notice {
        text: format!("{session_id} connected over {}", kind.label()),
    });

    // Everything this task emits is dropped by the log layer. Without the
    // marker, forwarding a log line would log a line about forwarding it. The
    // adapters wrap their writer tasks for the same reason.
    let pushes = tokio::spawn(FORWARDING.scope(
        (),
        push_events(
            link.outbound.clone(),
            state.clone(),
            session_id.clone(),
            kind,
        ),
    ));

    let outcome = pump(link, &state, &session_id).await;

    pushes.abort();
    state.publish(ServerPush::Notice {
        text: format!("{session_id} disconnected"),
    });

    outcome
}

/// The session's main loop: one inbound event at a time, until the transport
/// closes its end of the channel.
async fn pump(mut link: Link, state: &Arc<AppState>, session_id: &str) -> Result<()> {
    let mut uploads: HashMap<u64, app::Upload> = HashMap::new();
    // Said once per session, not once per chunk: these lines are forwarded to
    // every connected browser, so a peer that keeps pushing past the limit
    // would otherwise be flooding other people's consoles.
    let mut warned_about_uploads = false;

    while let Some(event) = link.inbound.recv().await {
        match event {
            Inbound::Call { request, reply } => {
                state.frames_in.fetch_add(1, Ordering::Relaxed);
                debug!(%session_id, transport = %link.kind.label(), ?request, "request");

                // Answering on its own task is what keeps a slow `fib` from
                // holding up an `echo` behind it. On WebTransport the streams
                // are already independent; on a WebSocket this is the only
                // thing that makes them so.
                let state = state.clone();
                tokio::spawn(async move {
                    // A dropped receiver means the caller gave up, which is not
                    // worth a log line of its own.
                    let _ = reply.send(app::answer(request, &state));
                });
            }

            Inbound::Datagram(DatagramIn::Ping { seq, sent_at_ms }) => {
                state.datagrams_in.fetch_add(1, Ordering::Relaxed);

                let pong = DatagramOut::Pong {
                    seq,
                    sent_at_ms,
                    server_time_ms: now_ms(),
                };

                // Fire and forget: a failure here means the peer went away, and
                // the loop will notice that on its own.
                if link.outbound.datagram(pong).await.is_err() {
                    break;
                }
            }

            Inbound::UploadChunk { id, bytes } => {
                if let Some(upload) = uploads.get_mut(&id) {
                    upload.chunk(bytes);
                } else if uploads.len() < MAX_OPEN_UPLOADS {
                    let mut upload = app::Upload::begin();
                    upload.chunk(bytes);
                    uploads.insert(id, upload);
                } else if !warned_about_uploads {
                    warned_about_uploads = true;
                    warn!(%session_id, id, "ignoring uploads past the open limit");
                }
            }

            Inbound::UploadEnd { id } => {
                if let Some(upload) = uploads.remove(&id) {
                    state.publish(upload.finish(state, session_id, carried_on(link.kind)));
                }
            }
        }
    }

    Ok(())
}

/// Follows both broadcast buses and pushes what they carry, for the life of the
/// session.
///
/// Application events and the server's own log records share the push lane, so
/// the client reads one source and sorts them out by tag.
async fn push_events(
    outbound: LinkSender,
    state: Arc<AppState>,
    session_id: String,
    kind: wt_shared::protocol::TransportKind,
) -> Result<()> {
    // Subscribe before the first await so nothing emitted in between is missed.
    let mut events = state.events.subscribe();
    let mut logs = state.logs.subscribe();

    outbound
        .push(ServerPush::Welcome {
            session_id: session_id.clone(),
            motd: motd(kind).to_owned(),
            boot: state.logs.boot().to_owned(),
            transport: kind,
        })
        .await?;

    outbound.push(state.telemetry()).await?;

    // Replay recent history so a browser opened after the fact still sees what
    // happened. The client drops any record it has already shown.
    for record in state.logs.history() {
        outbound.push(ServerPush::Log(record)).await?;
    }

    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(event) => outbound.push(event).await?,

                // This session fell behind the broadcast buffer. Say so plainly
                // rather than leaving a silent gap in the record.
                Err(RecvError::Lagged(missed)) => {
                    outbound
                        .push(ServerPush::Notice {
                            text: format!("{missed} events dropped, this session fell behind"),
                        })
                        .await?
                }

                Err(RecvError::Closed) => break,
            },

            record = logs.recv() => match record {
                Ok(record) => outbound.push(ServerPush::Log(record)).await?,

                Err(RecvError::Lagged(missed)) => {
                    outbound
                        .push(ServerPush::Notice {
                            text: format!("{missed} log records dropped on the way here"),
                        })
                        .await?
                }

                Err(RecvError::Closed) => break,
            },
        }
    }

    Ok(())
}

/// Spawns a per-stream task whose failure is worth a debug line and nothing
/// more. Used by the adapters, which have several such tasks per session.
pub fn spawn_logged<F>(what: &'static str, task: F)
where
    F: std::future::Future<Output = Result<()>> + Send + 'static,
{
    tokio::spawn(async move {
        if let Err(error) = task.await {
            debug!(%error, "{what} ended");
        }
    });
}

/// Parses one datagram payload, counting it either way: an unparseable
/// datagram still arrived, and the telemetry is about the wire, not the parse.
pub fn parse_datagram(payload: &[u8]) -> Option<DatagramIn> {
    match serde_json::from_slice::<DatagramIn>(payload) {
        Ok(datagram) => Some(datagram),
        Err(error) => {
            warn!(%error, "unparseable datagram");
            None
        }
    }
}

/// Hands an inbound event to the session, reporting whether it still wants
/// them. Adapters use the `false` to stop reading.
pub async fn deliver(inbound: &mpsc::Sender<Inbound>, event: Inbound) -> bool {
    inbound.send(event).await.is_ok()
}
