//! Everything that happens inside one accepted WebTransport session.
//!
//! A session runs four concurrent jobs:
//!
//! 1. accept bidirectional streams and answer requests on them,
//! 2. accept unidirectional streams and drain them (bulk upload),
//! 3. answer datagrams,
//! 4. push server-originated events down one long-lived unidirectional stream.
//!
//! Jobs 1-3 share a `select!` loop and spawn per-stream tasks so one slow
//! request can't stall the others. Job 4 is its own task.

use anyhow::Result;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::broadcast::error::RecvError;
use tracing::debug;
use tracing::info;
use tracing::warn;
use wtransport::endpoint::IncomingSession;
use wtransport::Connection;
use wtransport::RecvStream;
use wtransport::SendStream;

use wt_shared::compute;
use wt_shared::compute::human_bytes;
use wt_shared::protocol::DatagramIn;
use wt_shared::protocol::DatagramOut;
use wt_shared::protocol::Reply;
use wt_shared::protocol::Request;
use wt_shared::protocol::ServerPush;
use wt_shared::validate::validate_say;

use crate::clock::now_ms;
use crate::framing::write_frame;
use crate::framing::FrameReader;
use crate::logging::FORWARDING;
use crate::state::AppState;
use crate::state::SessionGuard;

/// Read buffer for bulk uploads.
const UPLOAD_CHUNK: usize = 64 * 1024;

pub async fn handle(
    incoming: IncomingSession,
    state: Arc<AppState>,
    session_id: String,
) -> Result<()> {
    // Three awaits to get a live session: transport handshake, then the
    // CONNECT request, then our acceptance of it.
    let request = incoming.await?;
    info!(
        authority = request.authority(),
        path = request.path(),
        "session requested"
    );

    let connection = Arc::new(request.accept().await?);
    let _guard = SessionGuard::enter(state.clone());

    state.publish(ServerPush::Notice {
        text: format!("{session_id} connected"),
    });

    // Everything this task emits is dropped by the log layer. Without the
    // marker, writing a log line would log a line about writing a log line.
    let pushes = tokio::spawn(FORWARDING.scope(
        (),
        push_events(connection.clone(), state.clone(), session_id.clone()),
    ));

    let outcome = pump(&connection, &state, &session_id).await;

    pushes.abort();
    state.publish(ServerPush::Notice {
        text: format!("{session_id} disconnected"),
    });

    outcome
}

/// The session's main loop. Returns when the connection drops.
async fn pump(connection: &Arc<Connection>, state: &Arc<AppState>, session_id: &str) -> Result<()> {
    loop {
        tokio::select! {
            accepted = connection.accept_bi() => {
                let (send, recv) = accepted?;
                spawn_logged(
                    "request stream",
                    serve_requests(send, recv, state.clone(), session_id.to_owned()),
                );
            }

            accepted = connection.accept_uni() => {
                let recv = accepted?;
                spawn_logged(
                    "upload stream",
                    drain_upload(recv, state.clone(), session_id.to_owned()),
                );
            }

            received = connection.receive_datagram() => {
                let datagram = received?;
                state.datagrams_in.fetch_add(1, Ordering::Relaxed);

                match serde_json::from_slice::<DatagramIn>(&datagram) {
                    Ok(DatagramIn::Ping { seq, sent_at_ms }) => {
                        let pong = DatagramOut::Pong {
                            seq,
                            sent_at_ms,
                            server_time_ms: now_ms(),
                        };
                        // Datagrams are fire and forget: an error here means the
                        // payload exceeded the path MTU or the peer went away.
                        if let Err(error) = connection.send_datagram(serde_json::to_vec(&pong)?) {
                            warn!(%error, "dropping pong");
                        }
                    }
                    Err(error) => warn!(%error, "unparseable datagram"),
                }
            }
        }
    }
}

/// Answers every request framed on one bidirectional stream. Browsers usually
/// open a fresh stream per request, but the loop supports pipelining too.
async fn serve_requests(
    mut send: SendStream,
    recv: RecvStream,
    state: Arc<AppState>,
    session_id: String,
) -> Result<()> {
    let mut reader = FrameReader::new(recv);

    while let Some(request) = reader.next::<Request>().await? {
        state.frames_in.fetch_add(1, Ordering::Relaxed);
        debug!(%session_id, ?request, "request");

        let reply = answer(request, &state);
        write_frame(&mut send, &reply).await?;
    }

    // Graceful FIN. Without it the peer sees a stream reset and discards
    // anything still buffered.
    send.finish().await?;
    Ok(())
}

/// The whole business layer: one `Request` in, one `Reply` out. Both
/// transports call this — WebTransport frames it over a stream, the HTTP API
/// takes it as JSON — so there is exactly one implementation to drift from.
///
/// The computation and the validation live in `wt-shared`; this function adds
/// only what the browser cannot: the clock, and the broadcast bus.
pub fn answer(request: Request, state: &AppState) -> Reply {
    match request {
        Request::Ping => Reply::Pong {
            server_time_ms: now_ms(),
        },

        Request::Echo { text } => Reply::Echo { text },

        Request::Reverse { text } => Reply::Reversed {
            text: compute::reverse(&text),
        },

        Request::Fib { n } => {
            let started = Instant::now();

            match compute::fib(n) {
                Ok(value) => Reply::Fib {
                    n,
                    value,
                    took_micros: started.elapsed().as_micros() as u64,
                },
                Err(message) => Reply::Error { message },
            }
        }

        Request::Say { author, text } => match validate_say(&author, &text) {
            Ok(said) => {
                state.publish(ServerPush::Said {
                    author: said.author,
                    text: said.text,
                    at_ms: now_ms(),
                });

                Reply::Accepted
            }
            Err(message) => Reply::Error { message },
        },
    }
}

/// Reads a unidirectional stream to its end and reports the throughput. This is
/// the bulk transfer path: no framing, just bytes.
async fn drain_upload(
    mut recv: RecvStream,
    state: Arc<AppState>,
    session_id: String,
) -> Result<()> {
    let started = Instant::now();
    let mut buffer = vec![0u8; UPLOAD_CHUNK];
    let mut total = 0u64;

    while let Some(read) = recv.read(&mut buffer).await? {
        total += read as u64;
    }

    let elapsed = started.elapsed();
    state.bytes_in.fetch_add(total, Ordering::Relaxed);

    let seconds = elapsed.as_secs_f64().max(0.000_001);
    let rate = total as f64 / seconds / (1024.0 * 1024.0);

    state.publish(ServerPush::Notice {
        text: format!(
            "{session_id} uploaded {} on one stream in {} ms ({rate:.1} MB/s)",
            human_bytes(total),
            elapsed.as_millis()
        ),
    });

    Ok(())
}

/// Opens the server's push stream and keeps it fed until the session ends.
///
/// Two sources share the stream: application events, and the server's own log
/// records. Both are framed identically, so the client reads one stream and
/// sorts them out by tag.
async fn push_events(
    connection: Arc<Connection>,
    state: Arc<AppState>,
    session_id: String,
) -> Result<()> {
    // Subscribe before the first await so nothing emitted in between is missed.
    let mut events = state.events.subscribe();
    let mut logs = state.logs.subscribe();

    // `open_uni` yields once the stream is requested, and again once flow
    // control lets it start, hence the two awaits.
    let mut stream = connection.open_uni().await?.await?;

    write_frame(
        &mut stream,
        &ServerPush::Welcome {
            session_id: session_id.clone(),
            motd: "Reliable frames arrive here in order. Datagrams take their chances.".into(),
            boot: state.logs.boot().to_owned(),
        },
    )
    .await?;

    write_frame(&mut stream, &state.telemetry()).await?;

    // Replay recent history so a browser opened after the fact still sees what
    // happened. The client drops any record it has already shown.
    for record in state.logs.history() {
        write_frame(&mut stream, &ServerPush::Log(record)).await?;
    }

    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(event) => write_frame(&mut stream, &event).await?,

                // This session fell behind the broadcast buffer. Say so plainly
                // rather than leaving a silent gap in the record.
                Err(RecvError::Lagged(missed)) => {
                    write_frame(
                        &mut stream,
                        &ServerPush::Notice {
                            text: format!("{missed} events dropped, this session fell behind"),
                        },
                    )
                    .await?
                }

                Err(RecvError::Closed) => break,
            },

            record = logs.recv() => match record {
                Ok(record) => write_frame(&mut stream, &ServerPush::Log(record)).await?,

                Err(RecvError::Lagged(missed)) => {
                    write_frame(
                        &mut stream,
                        &ServerPush::Notice {
                            text: format!("{missed} log records dropped on the way here"),
                        },
                    )
                    .await?
                }

                Err(RecvError::Closed) => break,
            },
        }
    }

    stream.finish().await?;
    Ok(())
}

fn spawn_logged<F>(what: &'static str, task: F)
where
    F: std::future::Future<Output = Result<()>> + Send + 'static,
{
    tokio::spawn(async move {
        if let Err(error) = task.await {
            debug!(%error, "{what} ended");
        }
    });
}
