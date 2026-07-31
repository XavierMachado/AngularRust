//! The business layer: one `Request` in, one `Reply` out.
//!
//! Every way into this server ends up here — a WebTransport bidirectional
//! stream, a WebSocket call frame, or a `POST /api/request` — so there is
//! exactly one implementation to drift from. Nothing in this module knows what
//! a stream, a socket or a datagram is.
//!
//! The computation and the validation live further down still, in `wt-shared`,
//! which the browser also runs through wasm. What this module adds is only what
//! the browser cannot have: the clock, and the broadcast bus.

use std::time::Instant;

use wt_shared::compute;
use wt_shared::compute::human_bytes;
use wt_shared::protocol::Reply;
use wt_shared::protocol::Request;
use wt_shared::protocol::ServerPush;
use wt_shared::validate::validate_say;

use crate::clock::now_ms;
use crate::state::AppState;

pub fn answer(request: Request, state: &AppState) -> Reply {
    match request {
        Request::Ping => Reply::Pong {
            server_time_ms: now_ms(),
        },

        Request::Echo { text } => Reply::Echo { text },

        Request::Reverse { text } => Reply::Reversed {
            text: compute::reverse(&text),
        },

        Request::Fib { n } => {
            let started = Instant::now();

            match compute::fib(n) {
                Ok(value) => Reply::Fib {
                    n,
                    value,
                    took_micros: started.elapsed().as_micros() as u64,
                },
                Err(message) => Reply::Error { message },
            }
        }

        Request::Say { author, text } => match validate_say(&author, &text) {
            Ok(said) => {
                state.publish(ServerPush::Said {
                    author: said.author,
                    text: said.text,
                    at_ms: now_ms(),
                });

                Reply::Accepted
            }
            Err(message) => Reply::Error { message },
        },
    }
}

/// Bulk upload accounting, transport-neutral.
///
/// The bytes themselves never reach here. A QUIC unidirectional stream and a
/// run of WebSocket upload-lane messages agree on nothing except how many bytes
/// there were and how long they took, so that is all this type is given — which
/// is also why the same throughput notice can describe either one.
pub struct Upload {
    started: Instant,
    total: u64,
}

impl Upload {
    pub fn begin() -> Self {
        Self {
            started: Instant::now(),
            total: 0,
        }
    }

    pub fn chunk(&mut self, bytes: usize) {
        self.total += bytes as u64;
    }

    /// Adds the total to the server-wide counter and returns the notice to
    /// broadcast. `carried_on` reads as "on one stream" or "on the socket" —
    /// the wording is the caller's, because only the caller knows.
    pub fn finish(self, state: &AppState, session_id: &str, carried_on: &str) -> ServerPush {
        let elapsed = self.started.elapsed();
        state
            .bytes_in
            .fetch_add(self.total, std::sync::atomic::Ordering::Relaxed);

        // A tiny upload can complete inside the clock's resolution; without the
        // floor the rate would be a division by zero.
        let seconds = elapsed.as_secs_f64().max(0.000_001);
        let rate = self.total as f64 / seconds / (1024.0 * 1024.0);

        ServerPush::Notice {
            text: format!(
                "{session_id} uploaded {} {carried_on} in {} ms ({rate:.1} MB/s)",
                human_bytes(self.total),
                elapsed.as_millis()
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::LogBus;
    use std::sync::Arc;
    use wt_shared::compute::MAX_FIB;

    /// An `AppState` with no server behind it. `LogBus::new` stands alone;
    /// `logging::init` must not be called here, because it installs a global
    /// subscriber that would then be shared by every test in the binary.
    fn state() -> Arc<AppState> {
        AppState::new(
            Vec::new(),
            String::new(),
            "https://localhost:4433/lab".into(),
            "ws://127.0.0.1:4433/ws".into(),
            LogBus::new(),
        )
    }

    #[test]
    fn ping_reports_the_server_clock() {
        let state = state();

        match answer(Request::Ping, &state) {
            Reply::Pong { server_time_ms } => assert!(server_time_ms > 0),
            other => panic!("expected a pong, got {other:?}"),
        }
    }

    #[test]
    fn echo_is_the_identity() {
        let state = state();

        match answer(
            Request::Echo {
                text: "日本語".into(),
            },
            &state,
        ) {
            Reply::Echo { text } => assert_eq!(text, "日本語"),
            other => panic!("expected an echo, got {other:?}"),
        }
    }

    #[test]
    fn reverse_matches_the_shared_implementation() {
        let state = state();

        match answer(
            Request::Reverse {
                text: "日本語".into(),
            },
            &state,
        ) {
            Reply::Reversed { text } => assert_eq!(text, compute::reverse("日本語")),
            other => panic!("expected a reversal, got {other:?}"),
        }
    }

    #[test]
    fn fib_answers_with_a_decimal_string() {
        let state = state();

        match answer(Request::Fib { n: 10 }, &state) {
            Reply::Fib { n, value, .. } => {
                assert_eq!(n, 10);
                assert_eq!(value, "55");
            }
            other => panic!("expected a fib, got {other:?}"),
        }
    }

    #[test]
    fn fib_past_the_ceiling_is_an_error_not_a_panic() {
        let state = state();

        match answer(Request::Fib { n: MAX_FIB + 1 }, &state) {
            Reply::Error { message } => assert!(message.contains(&MAX_FIB.to_string())),
            other => panic!("expected an error, got {other:?}"),
        }
    }

    #[test]
    fn say_broadcasts_exactly_one_line() {
        let state = state();
        let mut events = state.events.subscribe();

        assert!(matches!(
            answer(
                Request::Say {
                    author: "  ada  ".into(),
                    text: "  hello  ".into(),
                },
                &state,
            ),
            Reply::Accepted
        ));

        match events.try_recv().expect("one event on the bus") {
            ServerPush::Said { author, text, .. } => {
                // Trimmed by the shared rule, not by anything here.
                assert_eq!(author, "ada");
                assert_eq!(text, "hello");
            }
            other => panic!("expected a said, got {other:?}"),
        }

        assert!(events.try_recv().is_err(), "and nothing else");
    }

    #[test]
    fn an_empty_say_is_refused_and_broadcasts_nothing() {
        let state = state();
        let mut events = state.events.subscribe();

        match answer(
            Request::Say {
                author: "ada".into(),
                text: "   ".into(),
            },
            &state,
        ) {
            Reply::Error { .. } => {}
            other => panic!("expected an error, got {other:?}"),
        }

        assert!(events.try_recv().is_err(), "nothing reaches the bus");
    }

    #[test]
    fn an_upload_reports_its_size_and_counts_its_bytes() {
        let state = state();
        let mut upload = Upload::begin();

        upload.chunk(1024);
        upload.chunk(1024);

        match upload.finish(&state, "s001", "on the socket") {
            ServerPush::Notice { text } => {
                assert!(text.contains("s001"), "{text}");
                assert!(text.contains("2.0 KiB"), "{text}");
                assert!(text.contains("on the socket"), "{text}");
            }
            other => panic!("expected a notice, got {other:?}"),
        }

        assert_eq!(
            state.bytes_in.load(std::sync::atomic::Ordering::Relaxed),
            2048
        );
    }
}
