//! The third transport adapter, and the shortest one.
//!
//! `wt.rs` turns QUIC channels into a [`Link`]; `ws.rs` demultiplexes one
//! socket into the same shape; this file does it with no wire at all. Tauri
//! commands feed the session's inbound channel, and a forwarding task turns
//! its outbound channel into webview events. Everything downstream — the
//! welcome, telemetry, uploads, the log replay — is the same `session::run`
//! the network transports use.
//!
//! Two things the network adapters need simply disappear here. There is no
//! framing, because nothing is ever bytes on a wire; and there are no
//! correlation ids, because an `invoke` promise *is* its own correlation — the
//! command holds the session's `oneshot` and returns the reply directly.

use std::sync::Arc;
use std::sync::Mutex;

use tauri::Emitter;
use tauri::State;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

use wt_server::link::Inbound;
use wt_server::link::Link;
use wt_server::link::Outbound;
use wt_server::session;
use wt_server::state::AppState;
use wt_shared::protocol::DatagramIn;
use wt_shared::protocol::Reply;
use wt_shared::protocol::Request;
use wt_shared::protocol::TransportKind;

/// The desktop shell's one IPC session slot. One webview, one session — a
/// reconnect drops the old sender, which ends the old session's pump.
pub struct Ipc {
    server: Arc<AppState>,
    session: Mutex<Option<mpsc::Sender<Inbound>>>,
}

impl Ipc {
    pub fn new(server: Arc<AppState>) -> Self {
        Self {
            server,
            session: Mutex::new(None),
        }
    }

    /// The current session's inbound sender, if one is connected.
    fn sender(&self) -> Result<mpsc::Sender<Inbound>, String> {
        self.session
            .lock()
            .expect("the session lock")
            .clone()
            .ok_or_else(|| "no IPC session is connected".to_owned())
    }
}

#[tauri::command]
pub async fn ipc_connect(app: tauri::AppHandle, ipc: State<'_, Ipc>) -> Result<String, String> {
    // Closing the previous inbound channel is how its session learns to end.
    ipc.session.lock().expect("the session lock").take();

    let (link, inbound, mut outbound) = Link::new(TransportKind::Ipc);
    let session_id = ipc.server.mint_session_id();

    // Everything the session originates becomes a webview event. When the
    // session ends its `LinkSender` drops, the channel closes, and this task
    // ends with it.
    tauri::async_runtime::spawn(async move {
        while let Some(message) = outbound.recv().await {
            let delivered = match message {
                Outbound::Push(push) => app.emit("ipc:push", &push),
                Outbound::Datagram(datagram) => app.emit("ipc:datagram", &datagram),
            };

            if delivered.is_err() {
                break;
            }
        }
    });

    let state = ipc.server.clone();
    let id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let _ = session::run(link, state, id).await;
    });

    *ipc.session.lock().expect("the session lock") = Some(inbound);
    Ok(session_id)
}

#[tauri::command]
pub async fn ipc_call(ipc: State<'_, Ipc>, request: Request) -> Result<Reply, String> {
    let sender = ipc.sender()?;
    let (reply_tx, reply_rx) = oneshot::channel();

    sender
        .send(Inbound::Call {
            request,
            reply: reply_tx,
        })
        .await
        .map_err(|_| "the IPC session is gone".to_owned())?;

    reply_rx
        .await
        .map_err(|_| "the session dropped the call".to_owned())
}

#[tauri::command]
pub async fn ipc_datagram(ipc: State<'_, Ipc>, datagram: DatagramIn) -> Result<(), String> {
    let sender = ipc.sender()?;

    sender
        .send(Inbound::Datagram(datagram))
        .await
        .map_err(|_| "the IPC session is gone".to_owned())
}

/// One upload chunk, as a raw byte payload — real bytes cross the IPC
/// boundary, so the rate the panel reports measures actual IPC transfer, not
/// an accounting fiction. The upload id rides a header because the body is the
/// payload itself.
#[tauri::command]
pub async fn ipc_upload_chunk(
    ipc: State<'_, Ipc>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw byte payload".to_owned());
    };

    let id: u64 = request
        .headers()
        .get("x-upload-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| "missing or unreadable x-upload-id header".to_owned())?;

    let sender = ipc.sender()?;

    sender
        .send(Inbound::UploadChunk {
            id,
            bytes: bytes.len(),
        })
        .await
        .map_err(|_| "the IPC session is gone".to_owned())
}

#[tauri::command]
pub async fn ipc_upload_end(ipc: State<'_, Ipc>, id: u64) -> Result<(), String> {
    let sender = ipc.sender()?;

    sender
        .send(Inbound::UploadEnd { id })
        .await
        .map_err(|_| "the IPC session is gone".to_owned())
}

#[tauri::command]
pub async fn ipc_disconnect(ipc: State<'_, Ipc>) -> Result<(), String> {
    ipc.session.lock().expect("the session lock").take();
    Ok(())
}
