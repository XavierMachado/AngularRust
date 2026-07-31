//! The WebTransport adapter: QUIC channels in, [`Inbound`] out.
//!
//! WebTransport gives every logical lane a channel of its own, so this module
//! is mostly a set of small readers that agree on where to put what they find:
//!
//! * each client-opened bidirectional stream is one call, answered on itself;
//! * each client-opened unidirectional stream is one bulk upload;
//! * datagrams are datagrams;
//! * one server-opened unidirectional stream carries every push.
//!
//! Nothing here decides anything. What a request means, what an upload is worth
//! reporting, what the welcome says — all of that is in `session.rs`, shared
//! with the WebSocket adapter.

use anyhow::Result;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tracing::info;
use tracing::info_span;
use tracing::warn;
use tracing::Instrument;
use wtransport::endpoint::endpoint_side::Server;
use wtransport::endpoint::IncomingSession;
use wtransport::Connection;
use wtransport::Endpoint;
use wtransport::RecvStream;
use wtransport::SendStream;

use wt_shared::protocol::ClientFrame;
use wt_shared::protocol::ServerFrame;
use wt_shared::protocol::TransportKind;

use crate::framing::write_frame;
use crate::framing::FrameReader;
use crate::link::drain_writer;
use crate::link::Inbound;
use crate::link::Link;
use crate::link::Outbound;
use crate::logging::FORWARDING;
use crate::session;
use crate::session::deliver;
use crate::session::spawn_logged;
use crate::state::AppState;

/// Read buffer for bulk uploads.
const UPLOAD_CHUNK: usize = 64 * 1024;

/// Accepts sessions forever, one task each.
pub async fn accept_sessions(endpoint: Endpoint<Server>, state: Arc<AppState>) -> Result<()> {
    loop {
        let incoming = endpoint.accept().await;
        let state = state.clone();
        let session_id = state.mint_session_id();

        // The span's `id` field is what tags every log record from this session,
        // so the console can filter by it.
        let span = info_span!("session", id = %session_id);

        tokio::spawn(
            async move {
                if let Err(error) = handle(incoming, state, session_id).await {
                    info!("session closed: {error}");
                }
            }
            .instrument(span),
        );
    }
}

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
    let (link, inbound, outbound) = Link::new(TransportKind::WebTransport);

    // The writer owns the push stream and the datagram sender. It runs inside
    // the marker because it is the task that turns a log record into bytes, and
    // writing bytes emits log records.
    let writer = tokio::spawn(FORWARDING.scope(
        (),
        write_outbound(connection.clone(), outbound, session_id.clone()),
    ));

    let readers = tokio::spawn(read_channels(connection.clone(), inbound));

    let outcome = session::run(link, state, session_id).await;

    // The readers are blocked on a connection that is done; the writer still
    // owes the push stream a graceful `finish()`.
    readers.abort();
    drain_writer(writer).await;

    outcome
}

/// Feeds every QUIC channel into the one inbound channel.
///
/// Returns when the connection drops, which is what closes the inbound sender
/// and so ends the session loop.
async fn read_channels(connection: Arc<Connection>, inbound: mpsc::Sender<Inbound>) -> Result<()> {
    // Upload ids are per session and only have to be unique among the uploads
    // in flight; a QUIC stream carries no id of its own, so we mint one.
    let next_upload = Arc::new(AtomicU64::new(0));

    loop {
        tokio::select! {
            accepted = connection.accept_bi() => {
                let (send, recv) = accepted?;
                spawn_logged("request stream", serve_calls(send, recv, inbound.clone()));
            }

            accepted = connection.accept_uni() => {
                let recv = accepted?;
                let id = next_upload.fetch_add(1, Ordering::Relaxed);
                spawn_logged("upload stream", drain_upload(recv, id, inbound.clone()));
            }

            received = connection.receive_datagram() => {
                let datagram = received?;

                if let Some(parsed) = session::parse_datagram(&datagram) {
                    if !deliver(&inbound, Inbound::Datagram(parsed)).await {
                        return Ok(());
                    }
                }
            }
        }
    }
}

/// Answers every call framed on one bidirectional stream.
///
/// Browsers open a fresh stream per request, but the loop supports pipelining
/// too — the correlation id in the envelope is what makes that unambiguous.
async fn serve_calls(
    mut send: SendStream,
    recv: RecvStream,
    inbound: mpsc::Sender<Inbound>,
) -> Result<()> {
    let mut reader = FrameReader::new(recv);

    while let Some(ClientFrame::Call { id, request }) = reader.next::<ClientFrame>().await? {
        let (reply_tx, reply_rx) = oneshot::channel();

        if !deliver(
            &inbound,
            Inbound::Call {
                request,
                reply: reply_tx,
            },
        )
        .await
        {
            break;
        }

        // The session answers on its own task, so this await is the only thing
        // waiting — and it waits on the stream the request came in on, which is
        // exactly where the answer has to go back.
        let Ok(reply) = reply_rx.await else {
            break;
        };

        write_frame(&mut send, &ServerFrame::Result { id, reply }).await?;
    }

    // Graceful FIN. Without it the peer sees a stream reset and discards
    // anything still buffered.
    send.finish().await?;
    Ok(())
}

/// Reads a unidirectional stream to its end, reporting only its size.
async fn drain_upload(mut recv: RecvStream, id: u64, inbound: mpsc::Sender<Inbound>) -> Result<()> {
    let mut buffer = vec![0u8; UPLOAD_CHUNK];

    while let Some(read) = recv.read(&mut buffer).await? {
        if !deliver(&inbound, Inbound::UploadChunk { id, bytes: read }).await {
            return Ok(());
        }
    }

    deliver(&inbound, Inbound::UploadEnd { id }).await;
    Ok(())
}

/// Writes everything the server originates: pushes onto one long-lived
/// unidirectional stream, datagrams as datagrams.
async fn write_outbound(
    connection: Arc<Connection>,
    mut outbound: mpsc::Receiver<Outbound>,
    session_id: String,
) -> Result<()> {
    // `open_uni` yields once the stream is requested, and again once flow
    // control lets it start, hence the two awaits.
    let mut stream = connection.open_uni().await?.await?;

    while let Some(message) = outbound.recv().await {
        match message {
            Outbound::Push(push) => {
                write_frame(&mut stream, &ServerFrame::Push { push }).await?;
            }

            Outbound::Datagram(datagram) => {
                // Datagrams are fire and forget: an error here means the payload
                // exceeded the path MTU or the peer went away.
                if let Err(error) = connection.send_datagram(serde_json::to_vec(&datagram)?) {
                    warn!(%error, %session_id, "dropping pong");
                }
            }
        }
    }

    stream.finish().await?;
    Ok(())
}
