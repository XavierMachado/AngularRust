//! A WebTransport server with a WebSocket fallback, and a plain-HTTP side on
//! the same port number.
//!
//! Port 4433/udp  WebTransport over HTTP/3
//! Port 4433/tcp  `GET /discovery`, `GET /health`, `GET /telemetry`,
//!                `POST /api/request`, `GET /ws` — and the built Angular app,
//!                when `client/dist` exists
//!
//! TCP and UDP are separate port namespaces, so both listeners bind 4433 in one
//! process without conflict — the same way DNS holds 53 on both.
//!
//! ## One session, two transports
//!
//! WebTransport is the point of this lab, and it needs QUIC over UDP. Plenty of
//! networks do not have that, and browsers other than Chrome and Edge do not
//! have WebTransport at all, so there is a second way in over an ordinary
//! WebSocket.
//!
//! The two share everything above the wire. [`app`] is the business layer and
//! knows nothing about transports; [`session`] is the whole of what a session
//! does and knows only about a [`link::Link`], which is a channel in and a
//! channel out. [`wt`] and [`ws`] are the adapters that fill those channels —
//! one from QUIC's several channels, one from a WebSocket's single channel
//! demultiplexed by `wt_shared::lane`.
//!
//! What differs is only what genuinely differs. A WebSocket cannot lose a
//! datagram, so its datagram lane is an emulation, and the client is told which
//! transport it got so it can label the difference rather than paper over it.
//!
//! ## Why the discovery side-channel
//!
//! A browser will only open a WebTransport session to a server it trusts. In
//! development there is no public CA, so the client passes
//! `serverCertificateHashes` instead. Chrome accepts that only for an ECDSA
//! P-256 certificate valid for at most 14 days, which is exactly what
//! `Identity::self_signed` produces. The fingerprint changes on every restart,
//! so the client fetches it at connect time rather than having it pasted in.
//! The same response advertises the WebSocket URL and which transports this
//! server offers, so one fetch is enough to negotiate.

pub mod app;
pub mod boot;
pub mod clock;
pub mod framing;
pub mod http;
pub mod link;
pub mod logging;
pub mod session;
pub mod state;
pub mod ws;
pub mod wt;
