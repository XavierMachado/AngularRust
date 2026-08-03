//! The desktop shell again, on the experimental CEF runtime.
//!
//! Identical to `../../src/main.rs` in every way that matters — the same
//! embedded server, the same IPC adapter (literally the same file, included
//! by path) — except the webview is Chromium via CEF instead of the system
//! WebKitGTK. On Linux that is the difference between the WebSocket fallback
//! and real WebTransport with genuinely lossy datagrams.
//!
//! `cef_entry_point` matters here: CEF is a multi-process browser, and this
//! same executable is re-invoked as renderer, GPU and utility subprocesses.
//! The macro routes those invocations into CEF before the function body runs,
//! so the embedded server boots exactly once, in the browser process.

// Hide the console window that Windows otherwise opens beside the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[path = "../../src/ipc.rs"]
mod ipc;

#[tauri::cef_entry_point]
fn main() {
    let boot = wt_server::boot::prepare().expect("preparing the embedded server");
    let server = boot.state.clone();

    // The server owns its own runtime on its own thread, exactly as in the
    // stable shell; see ../../src/main.rs for the full account.
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Runtime::new().expect("building the server runtime");

        runtime.block_on(async {
            if let Err(error) = boot.run().await {
                eprintln!("embedded wt-server stopped: {error:?}");
            }
        });
    });

    tauri::Builder::<tauri::Cef>::new()
        .manage(ipc::Ipc::new(server))
        .invoke_handler(tauri::generate_handler![
            ipc::ipc_connect,
            ipc::ipc_call,
            ipc::ipc_datagram,
            ipc::ipc_upload_chunk,
            ipc::ipc_upload_end,
            ipc::ipc_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("running the desktop shell");
}
