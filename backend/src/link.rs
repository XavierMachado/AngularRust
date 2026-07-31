//! The seam between a transport and a session.
//!
//! A [`Link`] is a pair of channels and a label. Everything upstream of it —
//! QUIC streams, WebSocket lanes, the certificate, the HTTP upgrade — belongs
//! to an adapter (`wt.rs`, `ws.rs`). Everything downstream of it belongs to
//! `session.rs`, which is written once and cannot tell the two apart.
//!
//! ## Why channels rather than a trait
//!
//! A trait would have to be async, and an async trait with the `Send` bounds a
//! spawned task needs is either a dependency or a lot of ceremony. Channels
//! give the same decoupling with types the standard library already has, and
//! they give something a trait would not: the bounded [`Inbound`] channel *is*
//! the backpressure. When a session stops keeping up, the channel fills, the
//! adapter's read loop stops, and the transport's own flow control takes over —
//! QUIC's on one side, TCP's on the other.
//!
//! ## Why replies do not travel on the outbound channel
//!
//! Each [`Inbound::Call`] carries the `oneshot` its answer belongs in. The
//! adapter that created it knows where that answer has to go — back down the
//! bidirectional stream it arrived on, or into the socket's outbox tagged with
//! its correlation id — so the session never has to know, and neither side
//! needs a table mapping ids to destinations.

use tokio::sync::mpsc;
use tokio::sync::oneshot;

use wt_shared::protocol::DatagramIn;
use wt_shared::protocol::DatagramOut;
use wt_shared::protocol::Reply;
use wt_shared::protocol::Request;
use wt_shared::protocol::ServerPush;
use wt_shared::protocol::TransportKind;

/// How far a session may fall behind on inbound work before its transport is
/// made to wait. Upload chunks are the bulk of it, so this is measured in
/// reads, not requests.
pub const INBOUND_DEPTH: usize = 64;

/// How much server-originated traffic may queue for one session.
pub const OUTBOUND_DEPTH: usize = 256;

/// Something a client sent, whatever carried it.
pub enum Inbound {
    /// One request awaiting one reply.
    Call {
        request: Request,
        reply: oneshot::Sender<Reply>,
    },
    /// One datagram. Genuinely unreliable on WebTransport, emulated on a
    /// WebSocket — the session treats both the same, and the client is told
    /// which it got so it can say so.
    Datagram(DatagramIn),
    /// Bulk bytes arrived for upload `id`. Only the count travels: the session
    /// tallies, it does not inspect.
    UploadChunk { id: u64, bytes: usize },
    /// Upload `id` finished cleanly.
    UploadEnd { id: u64 },
}

/// Something the server originated.
pub enum Outbound {
    Push(ServerPush),
    Datagram(DatagramOut),
}

/// The write end of a session, cloneable so the push task can hold one.
#[derive(Clone)]
pub struct LinkSender(mpsc::Sender<Outbound>);

impl LinkSender {
    pub fn new(sender: mpsc::Sender<Outbound>) -> Self {
        Self(sender)
    }

    /// Queues a push. An error means the transport is gone, which is the
    /// session ending rather than a fault.
    pub async fn push(&self, push: ServerPush) -> Result<(), Closed> {
        self.0.send(Outbound::Push(push)).await.map_err(|_| Closed)
    }

    pub async fn datagram(&self, datagram: DatagramOut) -> Result<(), Closed> {
        self.0
            .send(Outbound::Datagram(datagram))
            .await
            .map_err(|_| Closed)
    }
}

/// The peer went away.
#[derive(Debug)]
pub struct Closed;

impl std::fmt::Display for Closed {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("the transport closed")
    }
}

impl std::error::Error for Closed {}

/// One session's transport, reduced to what a session needs from it.
pub struct Link {
    pub kind: TransportKind,
    pub inbound: mpsc::Receiver<Inbound>,
    pub outbound: LinkSender,
}

impl Link {
    /// Builds the channel pair, handing the adapter the ends it owns.
    pub fn new(kind: TransportKind) -> (Self, mpsc::Sender<Inbound>, mpsc::Receiver<Outbound>) {
        let (inbound_tx, inbound_rx) = mpsc::channel(INBOUND_DEPTH);
        let (outbound_tx, outbound_rx) = mpsc::channel(OUTBOUND_DEPTH);

        let link = Self {
            kind,
            inbound: inbound_rx,
            outbound: LinkSender::new(outbound_tx),
        };

        (link, inbound_tx, outbound_rx)
    }
}

/// How long a writer task gets to flush after its session ends.
const DRAIN_GRACE: std::time::Duration = std::time::Duration::from_millis(250);

/// Lets a writer task finish what it has already queued, then stops waiting.
///
/// When a session ends, its [`LinkSender`] drops and the writer's channel
/// closes — but there may still be a computed reply or a final notice in front
/// of it, and both transports end by closing something politely: a QUIC
/// `finish()`, a WebSocket close frame. Aborting the instant the session
/// returns would truncate that.
///
/// The wait is bounded because the usual reason a session ended is that the
/// peer went away, and a peer that has gone will never accept the flush.
/// Dropping a `JoinHandle` detaches rather than cancels, so the timeout path
/// still has to abort explicitly or the task would outlive the session.
pub async fn drain_writer(mut writer: tokio::task::JoinHandle<anyhow::Result<()>>) {
    if tokio::time::timeout(DRAIN_GRACE, &mut writer)
        .await
        .is_err()
    {
        writer.abort();
    }
}

/// How an upload notice should describe the thing that carried it.
///
/// A small thing to get right: "uploaded 2 MiB on one stream" is a claim about
/// QUIC that would be false over a WebSocket, where the bytes shared a channel
/// with everything else.
pub fn carried_on(kind: TransportKind) -> &'static str {
    match kind {
        TransportKind::WebTransport => "on one stream",
        TransportKind::WebSocket => "on the socket",
    }
}

/// The greeting, which differs because the guarantees differ.
pub fn motd(kind: TransportKind) -> &'static str {
    match kind {
        TransportKind::WebTransport => {
            "Reliable frames arrive here in order. Datagrams take their chances."
        }
        TransportKind::WebSocket => {
            "One ordered, reliable channel carries every lane. Nothing here is dropped, \
             including the datagrams — they are emulated."
        }
    }
}
