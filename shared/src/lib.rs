//! Code that runs on both sides of the wire.
//!
//! The server links this crate natively; the browser gets it through the
//! `wt-wasm` bindings. Everything here is pure computation over bytes and
//! strings — no sockets, no clock, no async — which is what lets one
//! implementation serve both.

pub mod compute;
pub mod framing;
pub mod protocol;
pub mod validate;
