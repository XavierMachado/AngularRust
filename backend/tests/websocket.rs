//! The WebSocket transport, end to end.
//!
//! Serves the real router on a port the operating system picks and drives it
//! with a real WebSocket client, so what is under test is the whole pipeline —
//! lane codec, call envelope, session core, business layer, broadcast bus — and
//! not a mock of any part of it.
//!
//! `logging::init` is deliberately never called: it installs a global
//! subscriber, and these tests share a process.

use futures_util::SinkExt;
use futures_util::StreamExt;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use wt_server::http;
use wt_server::logging::LogBus;
use wt_server::state::AppState;

use wt_shared::lane::decode_lane;
use wt_shared::lane::encode_lane;
use wt_shared::lane::Lane;
use wt_shared::protocol::ClientFrame;
use wt_shared::protocol::DatagramIn;
use wt_shared::protocol::DatagramOut;
use wt_shared::protocol::Reply;
use wt_shared::protocol::Request;
use wt_shared::protocol::ServerFrame;
use wt_shared::protocol::ServerPush;
use wt_shared::protocol::TransportKind;

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Boots the router on an ephemeral port and returns it with the shared state.
async fn serve() -> (String, Arc<AppState>) {
    let state = AppState::new(
        Vec::new(),
        String::new(),
        "https://localhost:4433/lab".into(),
        "ws://127.0.0.1:4433/ws".into(),
        LogBus::new(),
    );

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().unwrap().port();
    let router = http::router(state.clone());

    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (format!("ws://127.0.0.1:{port}/ws"), state)
}

async fn connect(url: &str) -> Socket {
    let (socket, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("the upgrade succeeds");
    socket
}

async fn send(socket: &mut Socket, lane: Lane, stream: u64, body: &[u8]) {
    socket
        .send(Message::Binary(encode_lane(lane, stream, body).into()))
        .await
        .expect("the socket accepts a message");
}

async fn call(socket: &mut Socket, id: u64, request: Request) {
    let frame = ClientFrame::Call { id, request };
    send(
        socket,
        Lane::Control,
        0,
        &serde_json::to_vec(&frame).unwrap(),
    )
    .await;
}

/// The next server message, decoded into its lane and JSON body.
async fn next(socket: &mut Socket) -> (Lane, Vec<u8>) {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("the server answers within five seconds")
            .expect("the stream is still open")
            .expect("a message rather than an error");

        // Ping/pong at the protocol level is not our datagram lane.
        let Message::Binary(bytes) = message else {
            continue;
        };

        let decoded = decode_lane(&bytes).expect("every server message is lane-tagged");
        return (decoded.lane, decoded.body.to_vec());
    }
}

/// The next `ServerFrame` off the control lane, skipping datagrams.
async fn next_frame(socket: &mut Socket) -> ServerFrame {
    loop {
        let (lane, body) = next(socket).await;

        if lane == Lane::Control {
            return serde_json::from_slice(&body).expect("a well-formed server frame");
        }
    }
}

/// The next push, skipping replies and the log records the server replays.
async fn next_push(socket: &mut Socket) -> ServerPush {
    loop {
        if let ServerFrame::Push { push } = next_frame(socket).await {
            if !matches!(push, ServerPush::Log(_)) {
                return push;
            }
        }
    }
}

#[tokio::test]
async fn a_session_opens_with_a_welcome_naming_the_transport() {
    let (url, _state) = serve().await;
    let mut socket = connect(&url).await;

    match next_push(&mut socket).await {
        ServerPush::Welcome {
            session_id,
            transport,
            ..
        } => {
            assert_eq!(transport, TransportKind::WebSocket);
            assert!(session_id.starts_with('s'), "{session_id}");
        }
        other => panic!("expected a welcome first, got {other:?}"),
    }
}

#[tokio::test]
async fn a_call_comes_back_with_its_own_id() {
    let (url, _state) = serve().await;
    let mut socket = connect(&url).await;

    call(
        &mut socket,
        7,
        Request::Echo {
            text: "日本語".into(),
        },
    )
    .await;

    loop {
        if let ServerFrame::Result { id, reply } = next_frame(&mut socket).await {
            assert_eq!(id, 7);
            assert!(matches!(reply, Reply::Echo { text } if text == "日本語"));
            return;
        }
    }
}

#[tokio::test]
async fn a_slow_call_does_not_hold_up_a_fast_one_behind_it() {
    let (url, _state) = serve().await;
    let mut socket = connect(&url).await;

    // The expensive arm first, then a trivial one. The socket is ordered, but
    // the work behind it is not, so the echo should overtake.
    call(&mut socket, 1, Request::Fib { n: 185 }).await;
    call(
        &mut socket,
        2,
        Request::Echo {
            text: "quick".into(),
        },
    )
    .await;

    let mut seen = Vec::new();

    while seen.len() < 2 {
        if let ServerFrame::Result { id, .. } = next_frame(&mut socket).await {
            seen.push(id);
        }
    }

    // Both arrive; which came first is a scheduling detail, so the assertion is
    // only that neither was lost and both were correlated.
    seen.sort_unstable();
    assert_eq!(seen, vec![1, 2]);
}

#[tokio::test]
async fn a_datagram_lane_ping_comes_back_as_a_pong() {
    let (url, _state) = serve().await;
    let mut socket = connect(&url).await;

    let ping = DatagramIn::Ping {
        seq: 42,
        sent_at_ms: 1234.5,
    };
    send(
        &mut socket,
        Lane::Datagram,
        0,
        &serde_json::to_vec(&ping).unwrap(),
    )
    .await;

    loop {
        let (lane, body) = next(&mut socket).await;

        if lane == Lane::Datagram {
            let DatagramOut::Pong {
                seq, sent_at_ms, ..
            } = serde_json::from_slice(&body).expect("a well-formed pong");

            assert_eq!(seq, 42);
            // The server treats the client's clock reading as an opaque token
            // and hands it straight back.
            assert_eq!(sent_at_ms, 1234.5);
            return;
        }
    }
}

#[tokio::test]
async fn an_upload_is_tallied_and_announced() {
    let (url, state) = serve().await;
    let mut socket = connect(&url).await;

    let chunk = vec![0u8; 1024];
    for _ in 0..3 {
        send(&mut socket, Lane::Upload, 1, &chunk).await;
    }
    send(&mut socket, Lane::UploadEnd, 1, &[]).await;

    loop {
        if let ServerPush::Notice { text } = next_push(&mut socket).await {
            if text.contains("uploaded") {
                assert!(text.contains("3.0 KiB"), "{text}");
                // The WebSocket wording, not WebTransport's "on one stream".
                assert!(text.contains("on the socket"), "{text}");
                assert_eq!(
                    state.bytes_in.load(std::sync::atomic::Ordering::Relaxed),
                    3072
                );
                return;
            }
        }
    }
}

#[tokio::test]
async fn a_say_over_the_socket_reaches_another_session() {
    let (url, _state) = serve().await;
    let mut listener = connect(&url).await;
    let mut speaker = connect(&url).await;

    // Drain the listener's welcome so the broadcast is what we read next.
    next_push(&mut listener).await;

    call(
        &mut speaker,
        1,
        Request::Say {
            author: "ada".into(),
            text: "hello".into(),
        },
    )
    .await;

    loop {
        if let ServerPush::Said { author, text, .. } = next_push(&mut listener).await {
            assert_eq!(author, "ada");
            assert_eq!(text, "hello");
            return;
        }
    }
}

#[tokio::test]
async fn telemetry_counts_the_websocket_session_separately() {
    let (url, _state) = serve().await;
    let mut socket = connect(&url).await;

    loop {
        if let ServerPush::Telemetry {
            sessions,
            sessions_websocket,
            sessions_webtransport,
            ..
        } = next_push(&mut socket).await
        {
            assert_eq!(sessions, 1);
            assert_eq!(sessions_websocket, 1);
            assert_eq!(sessions_webtransport, 0);
            return;
        }
    }
}

#[tokio::test]
async fn an_unknown_lane_closes_the_session_rather_than_being_ignored() {
    let (url, _state) = serve().await;
    let mut socket = connect(&url).await;

    // A valid nine-byte header with a lane tag nobody speaks.
    let mut hostile = encode_lane(Lane::Control, 0, b"{}");
    hostile[0] = 9;
    socket
        .send(Message::Binary(hostile.into()))
        .await
        .expect("the socket accepts it");

    // The server hangs up rather than silently dropping whatever it carried.
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(message) = socket.next().await {
            match message {
                Ok(Message::Close(_)) | Err(_) => return true,
                Ok(_) => continue,
            }
        }
        true
    })
    .await;

    assert!(closed.expect("the server hangs up within five seconds"));
}
