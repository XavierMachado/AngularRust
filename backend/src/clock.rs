//! The one clock call in the codebase.
//!
//! This lives in the backend rather than `wt-shared` deliberately:
//! `SystemTime::now()` compiles for wasm32-unknown-unknown but panics at
//! runtime, so the shared crate stays clock-free and the browser reads time
//! from JavaScript instead.

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}
