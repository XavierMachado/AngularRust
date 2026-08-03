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
//! On Windows the webview is WebView2 (Chromium), which has WebTransport, so
//! the app connects over QUIC when udp/4433 is free. On Linux it is WebKitGTK,
//! which has no WebTransport — the console negotiates its WebSocket fallback
//! exactly as it would in Firefox, and says so in the masthead. That fallback
//! working is the point of the lab, not a compromise.

// Hide the console window that Windows otherwise opens beside the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The server owns its own runtime on its own thread, exactly as if
    // `cargo run -p wt-server` were running beside the app. If TCP 4433 is
    // already taken — usually a second copy of this app — the server thread
    // reports it and exits, and the webview shows the console offline; the
    // usual `cargo run` diagnostics apply unchanged.
    std::thread::spawn(|| {
        let runtime = tokio::runtime::Runtime::new().expect("building the server runtime");

        runtime.block_on(async {
            if let Err(error) = wt_server::boot::run().await {
                eprintln!("embedded wt-server stopped: {error:?}");
            }
        });
    });

    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("running the desktop shell");
}
