//! The console as a desktop app: the whole `wt-server` runs inside this
//! process while the webview shows one of the two consoles, so the executable
//! is self-contained — no separate server to start, nothing to install beside
//! it.
//!
//! Which console is baked in is a packaging decision, not a code one: the
//! default `tauri.conf.json` bundles the Lit build, and
//! `tauri.angular.conf.json` overlays the Angular build instead. The Rust in
//! this file is identical for both.
//!
//! Being in one process buys a third transport the browser cannot have:
//! `ipc.rs` feeds sessions straight into the server over Tauri's IPC, no
//! network involved. The network lanes still work exactly as in a browser —
//! on Windows the webview is WebView2 (Chromium), which has WebTransport; on
//! Linux it is WebKitGTK, which falls back to the WebSocket. The IPC lane is
//! the one that works even when tcp/4433 is already taken by another copy of
//! this app.

// Hide the console window that Windows otherwise opens beside the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ipc;

fn main() {
    let boot = wt_server::boot::prepare().expect("preparing the embedded server");
    let server = boot.state.clone();

    // The server owns its own runtime on its own thread, exactly as if
    // `cargo run -p wt-server` were running beside the app. If TCP 4433 is
    // already taken — usually a second copy of this app — the listeners report
    // it and the network lanes stay dark, but the IPC lane above needs no port
    // and keeps working.
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Runtime::new().expect("building the server runtime");

        runtime.block_on(async {
            if let Err(error) = boot.run().await {
                eprintln!("embedded wt-server stopped: {error:?}");
            }
        });
    });

    tauri::Builder::default()
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
