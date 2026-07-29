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

use crate::framing::read_frame;
use crate::framing::write_frame;
use crate::logging::FORWARDING;
use crate::protocol::now_ms;
use crate::protocol::DatagramIn;
use crate::protocol::DatagramOut;
use crate::protocol::Reply;
use crate::protocol::Request;
use crate::protocol::ServerPush;
use crate::state::AppState;
use crate::state::SessionGuard;

/// Read buffer for bulk uploads.
const UPLOAD_CHUNK: usize = 64 * 1024;

/// `Fib` is a CPU burner, not a maths library. Keep it inside u128.
const MAX_FIB: u32 = 185;

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
    mut recv: RecvStream,
    state: Arc<AppState>,
    session_id: String,
) -> Result<()> {
    while let Some(request) = read_frame::<Request>(&mut recv).await? {
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

fn answer(request: Request, state: &AppState) -> Reply {
    match request {
        Request::Ping => Reply::Pong {
            server_time_ms: now_ms(),
        },

        Request::Echo { text } => Reply::Echo { text },

        Request::Reverse { text } => Reply::Reversed {
            text: text.chars().rev().collect(),
        },

        Request::Fib { n } if n > MAX_FIB => Reply::Error {
            message: format!("n must be {MAX_FIB} or less"),
        },

        Request::Fib { n } => {
            let started = Instant::now();
            let (mut a, mut b) = (0u128, 1u128);
            for _ in 0..n {
                (a, b) = (b, a + b);
            }

            Reply::Fib {
                n,
                value: a.to_string(),
                took_micros: started.elapsed().as_micros() as u64,
            }
        }

        Request::Say { author, text } => {
            let author = trim_to(author.trim(), 24);
            let text = trim_to(text.trim(), 280);

            if text.is_empty() {
                return Reply::Error {
                    message: "message is empty".into(),
                };
            }

            state.publish(ServerPush::Said {
                author: if author.is_empty() {
                    "anonymous".into()
                } else {
                    author
                },
                text,
                at_ms: now_ms(),
            });

            Reply::Accepted
        }
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

fn trim_to(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KiB", "MiB", "GiB"];
    let mut value = bytes as f64;
    let mut unit = 0;

    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }

    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::human_bytes;
    use super::trim_to;

    #[test]
    fn bytes_read_the_way_people_write_them() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(1024), "1.0 KiB");
        assert_eq!(human_bytes(1536), "1.5 KiB");
        assert_eq!(human_bytes(5 * 1024 * 1024), "5.0 MiB");
    }

    #[test]
    fn trimming_counts_characters_not_bytes() {
        assert_eq!(trim_to("hello", 10), "hello");
        assert_eq!(trim_to("hello", 3), "hel");
        // Four characters, twelve bytes: a byte-wise truncation would split one.
        assert_eq!(trim_to("日本語です", 4), "日本語で");
    }
}
