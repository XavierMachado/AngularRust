//! The WebSocket adapter: everything a session does, over one channel.
//!
//! WebTransport hands a session three channels with three different promises.
//! A WebSocket hands you one, ordered and reliable, and this module spends its
//! length being honest about the difference:
//!
//! * calls carry a correlation id, because there is no stream to do it for us —
//!   but each is still answered on its own task, so a slow `fib` does not hold
//!   up an `echo` queued behind it;
//! * bulk upload rides its own lane as raw bytes, so a megabyte does not become
//!   1.4 MB of base64 inside the JSON it shares a socket with;
//! * "datagrams" are a lane, not a channel. Nothing is lost and nothing is
//!   reordered, and the client says so rather than reporting a perfect delivery
//!   rate as though it meant something.
//!
//! ## Two things worth knowing before changing this
//!
//! **WebSocket upgrades are not subject to CORS.** The permissive `CorsLayer`
//! on the rest of the router does nothing for `/ws`; any page anywhere can open
//! this socket. Against localhost in development that is the same exposure the
//! rest of this listener already has, but in production `/ws` needs an explicit
//! `Origin` check. It is the classic mistake with this API.
//!
//! **The protocol's own ping frames are not our datagram pings.** axum answers
//! `Message::Ping` itself, at the WebSocket layer. The ping and pong this
//! console measures ride the datagram lane and are application messages.

use anyhow::Result;
use axum::body::Bytes;
use axum::extract::ws::Message;
use axum::extract::ws::WebSocket;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::State;
use axum::response::Response;
use futures_util::sink::SinkExt;
use futures_util::stream::SplitSink;
use futures_util::stream::SplitStream;
use futures_util::stream::StreamExt;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tracing::info;
use tracing::info_span;
use tracing::warn;
use tracing::Instrument;

use wt_shared::framing::MAX_FRAME_BYTES;
use wt_shared::lane::decode_lane;
use wt_shared::lane::encode_lane;
use wt_shared::lane::Lane;
use wt_shared::protocol::ClientFrame;
use wt_shared::protocol::Reply;
use wt_shared::protocol::ServerFrame;
use wt_shared::protocol::TransportKind;

use crate::link::Inbound;
use crate::link::Link;
use crate::link::Outbound;
use crate::logging::FORWARDING;
use crate::session;
use crate::session::deliver;
use crate::state::AppState;

/// The JSON lanes are already capped at [`MAX_FRAME_BYTES`] by the lane codec;
/// this is the transport-level ceiling, with room for the lane header. Upload
/// chunks are far smaller — the client sends 16 KiB at a time.
const MAX_MESSAGE: usize = MAX_FRAME_BYTES + 64;

/// How many replies may queue while the writer is busy.
const REPLY_DEPTH: usize = 64;

pub async fn upgrade(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> Response {
    ws.max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_MESSAGE)
        .on_upgrade(move |socket| async move {
            let session_id = state.mint_session_id();
            let span = info_span!("session", id = %session_id);

            async move {
                info!("session requested");

                if let Err(error) = serve(socket, state, session_id).await {
                    info!("session closed: {error}");
                }
            }
            .instrument(span)
            .await
        })
}

async fn serve(socket: WebSocket, state: Arc<AppState>, session_id: String) -> Result<()> {
    let (sink, stream) = socket.split();
    let (link, inbound, outbound) = Link::new(TransportKind::WebSocket);

    // Replies do not travel on the session's outbound channel — a reply belongs
    // to the call that asked for it, and the session hands it straight back on
    // a oneshot. They need their own way to the sink, which only the writer
    // task may touch.
    let (replies_tx, replies_rx) = mpsc::channel::<Bytes>(REPLY_DEPTH);

    // Only this task touches the sink, and only this task can describe the act
    // of shipping a log line — so it, alone, runs inside the marker. The push
    // loop stays outside it, which means its own lag notices still reach the
    // browser.
    let writer = tokio::spawn(FORWARDING.scope((), write_outbound(sink, outbound, replies_rx)));
    let reader = tokio::spawn(read_socket(stream, inbound, replies_tx));

    let outcome = session::run(link, state, session_id).await;

    reader.abort();
    writer.abort();

    outcome
}

/// Turns socket messages into inbound events.
///
/// Returns when the socket closes or the session stops wanting events, either
/// of which drops the inbound sender and so ends the session loop.
async fn read_socket(
    mut stream: SplitStream<WebSocket>,
    inbound: mpsc::Sender<Inbound>,
    replies: mpsc::Sender<Bytes>,
) -> Result<()> {
    while let Some(message) = stream.next().await {
        let payload = match message? {
            Message::Binary(bytes) => bytes,

            // Text is not part of this protocol: every lane is binary, which is
            // what lets the upload lane stay raw.
            Message::Text(_) => {
                warn!("ignoring a text message; every lane here is binary");
                continue;
            }

            Message::Close(_) => break,

            // axum answers protocol-level pings itself; these are the echoes,
            // and they are not the datagram lane's ping.
            Message::Ping(_) | Message::Pong(_) => continue,
        };

        let decoded = match decode_lane(&payload) {
            Ok(decoded) => decoded,
            Err(error) => {
                // A message we cannot route is a broken peer, not a bad frame to
                // skip: continuing would silently drop whatever it carried.
                warn!(%error, "closing the session on an undecodable message");
                break;
            }
        };

        let delivered = match decoded.lane {
            Lane::Control => match serde_json::from_slice::<ClientFrame>(decoded.body) {
                Ok(ClientFrame::Call { id, request }) => {
                    let (reply_tx, reply_rx) = oneshot::channel();
                    let sent = deliver(
                        &inbound,
                        Inbound::Call {
                            request,
                            reply: reply_tx,
                        },
                    )
                    .await;

                    if sent {
                        // Awaiting the answer here would serialise every call
                        // behind the slowest one. The socket is ordered; the
                        // work behind it need not be.
                        let replies = replies.clone();
                        tokio::spawn(async move {
                            if let Ok(reply) = reply_rx.await {
                                if let Ok(bytes) = result_frame(id, reply) {
                                    let _ = replies.send(bytes).await;
                                }
                            }
                        });
                    }

                    sent
                }

                Err(error) => {
                    warn!(%error, "unparseable call frame");
                    true
                }
            },

            Lane::Datagram => match session::parse_datagram(decoded.body) {
                Some(parsed) => deliver(&inbound, Inbound::Datagram(parsed)).await,
                None => true,
            },

            Lane::Upload => {
                deliver(
                    &inbound,
                    Inbound::UploadChunk {
                        id: decoded.stream,
                        bytes: decoded.body.len(),
                    },
                )
                .await
            }

            Lane::UploadEnd => deliver(&inbound, Inbound::UploadEnd { id: decoded.stream }).await,
        };

        if !delivered {
            break;
        }
    }

    Ok(())
}

/// Writes everything the server sends, each as one binary message tagged with
/// its lane. The only task that touches the sink.
async fn write_outbound(
    mut sink: SplitSink<WebSocket, Message>,
    mut outbound: mpsc::Receiver<Outbound>,
    mut replies: mpsc::Receiver<Bytes>,
) -> Result<()> {
    loop {
        let bytes = tokio::select! {
            message = outbound.recv() => match message {
                Some(Outbound::Push(push)) => control(&ServerFrame::Push { push })?,
                Some(Outbound::Datagram(datagram)) => lane_json(Lane::Datagram, &datagram)?,
                None => break,
            },

            reply = replies.recv() => match reply {
                Some(bytes) => bytes,
                None => break,
            },
        };

        sink.send(Message::Binary(bytes)).await?;
    }

    let _ = sink.close().await;
    Ok(())
}

fn result_frame(id: u64, reply: Reply) -> Result<Bytes> {
    control(&ServerFrame::Result { id, reply })
}

fn control(frame: &ServerFrame) -> Result<Bytes> {
    lane_json(Lane::Control, frame)
}

fn lane_json<T: serde::Serialize>(lane: Lane, message: &T) -> Result<Bytes> {
    // The control and datagram lanes carry no stream id: they are not one
    // transfer among several, the way an upload is.
    Ok(Bytes::from(encode_lane(
        lane,
        0,
        &serde_json::to_vec(message)?,
    )))
}
