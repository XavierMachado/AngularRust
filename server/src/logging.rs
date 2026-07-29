//! Server logs, delivered to the browser.
//!
//! A `tracing` layer sits beside the usual stdout formatter and copies every
//! event it is allowed to forward onto a broadcast bus. Sessions subscribe to
//! that bus and push the records down the same unidirectional stream that
//! carries telemetry, so the console shows the server's own view of what
//! happened rather than the client's guess at it.
//!
//! ## The obvious hazard
//!
//! Forwarding a log line means writing to a QUIC stream, and writing to a QUIC
//! stream can itself emit log lines. Left alone that is an infinite loop that
//! saturates the connection with descriptions of itself. Two guards:
//!
//! 1. [`FORWARDING`] is a task-local marker set for the whole lifetime of a
//!    session's push task. Any event emitted from inside that task is dropped
//!    here rather than queued. This is the guard that actually closes the loop,
//!    and it survives `.await` points because it is a tokio task-local rather
//!    than a thread-local.
//! 2. [`MUTED_TARGETS`] drops the transport stack's own chatter outright, which
//!    is noise rather than a loop, but noise measured in thousands of lines a
//!    second under load.

use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::broadcast;
use tracing::field::Field;
use tracing::field::Visit;
use tracing::span::Attributes;
use tracing::span::Id;
use tracing::Event;
use tracing::Level;
use tracing::Subscriber;
use tracing_subscriber::layer::Context;
use tracing_subscriber::prelude::*;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::Layer;

use crate::protocol::now_ms;
use crate::protocol::ServerLog;

/// Replayed to each session when it connects, so a browser opened after the
/// interesting thing happened still sees it.
const HISTORY_DEPTH: usize = 250;

/// How far a session may fall behind before it starts losing log records.
const CHANNEL_DEPTH: usize = 512;

/// The transport stack describes every packet it touches. Useful in a terminal
/// with a narrow filter, unusable as a live feed.
const MUTED_TARGETS: [&str; 6] = ["quinn", "rustls", "h3", "hyper", "tower", "axum"];

tokio::task_local! {
    /// Set inside a session's push task. See the module docs.
    pub static FORWARDING: ();
}

/// Fan-out for log records, plus a short replayable history.
pub struct LogBus {
    sender: broadcast::Sender<ServerLog>,
    history: Mutex<VecDeque<ServerLog>>,
    /// Identifies this process run. The client uses it to tell a replayed
    /// record apart from a fresh one after the server restarts and sequence
    /// numbers begin again at zero.
    boot: String,
    seq: AtomicU64,
}

impl LogBus {
    pub fn new() -> Arc<Self> {
        let (sender, _) = broadcast::channel(CHANNEL_DEPTH);

        Arc::new(Self {
            sender,
            history: Mutex::new(VecDeque::with_capacity(HISTORY_DEPTH)),
            boot: format!("{:x}", now_ms()),
            seq: AtomicU64::new(0),
        })
    }

    pub fn boot(&self) -> &str {
        &self.boot
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerLog> {
        self.sender.subscribe()
    }

    /// The most recent records, oldest first.
    pub fn history(&self) -> Vec<ServerLog> {
        match self.history.lock() {
            Ok(history) => history.iter().cloned().collect(),
            Err(_) => Vec::new(),
        }
    }

    fn publish(&self, mut record: ServerLog) {
        record.seq = self.seq.fetch_add(1, Ordering::Relaxed);

        if let Ok(mut history) = self.history.lock() {
            if history.len() == HISTORY_DEPTH {
                history.pop_front();
            }

            history.push_back(record.clone());
        }

        // An error here only means nobody is subscribed.
        let _ = self.sender.send(record);
    }
}

/// Installs the stdout formatter and the forwarding layer. `RUST_LOG` applies
/// to both.
pub fn init(bus: Arc<LogBus>) {
    // RUST_LOG wins when it is set; otherwise this crate runs at debug and
    // everything else at info, which is roughly what is worth watching live.
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,wt_server=debug"));

    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_target(true))
        .with(BroadcastLayer { bus })
        .init();
}

struct BroadcastLayer {
    bus: Arc<LogBus>,
}

/// Fields captured when a span opened, so events inside it can inherit them.
struct SpanFields(BTreeMap<String, String>);

impl<S> Layer<S> for BroadcastLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attributes: &Attributes<'_>, id: &Id, context: Context<'_, S>) {
        let mut visitor = FieldVisitor::default();
        attributes.record(&mut visitor);

        if let Some(span) = context.span(id) {
            span.extensions_mut().insert(SpanFields(visitor.fields));
        }
    }

    fn on_event(&self, event: &Event<'_>, context: Context<'_, S>) {
        // Emitted from inside a push task: dropping it is what stops the loop.
        if FORWARDING.try_with(|_| ()).is_ok() {
            return;
        }

        let metadata = event.metadata();
        if !forwardable(metadata.target(), *metadata.level()) {
            return;
        }

        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);

        let mut fields = visitor.fields;
        let mut session = None;

        // Walk outermost span inward so inner fields win on a name collision.
        if let Some(scope) = context.event_scope(event) {
            for span in scope.from_root() {
                let extensions = span.extensions();

                if let Some(SpanFields(span_fields)) = extensions.get::<SpanFields>() {
                    if span.name() == "session" {
                        session = span_fields.get("id").cloned();
                    }

                    for (name, value) in span_fields {
                        fields.insert(name.clone(), value.clone());
                    }
                }
            }
        }

        self.bus.publish(ServerLog {
            seq: 0, // assigned by the bus
            at_ms: now_ms(),
            level: level_name(*metadata.level()),
            target: metadata.target().to_owned(),
            message: visitor.message.unwrap_or_default(),
            fields,
            session,
        });
    }
}

/// Forward this crate's own events at any level, plus warnings and errors from
/// anywhere. A dependency's info and debug lines are for the terminal.
fn forwardable(target: &str, level: Level) -> bool {
    if MUTED_TARGETS.iter().any(|muted| target.starts_with(muted)) {
        return false;
    }

    // In tracing's ordering, ERROR is the lowest level and TRACE the highest.
    target.starts_with("wt_server") || level <= Level::WARN
}

fn level_name(level: Level) -> String {
    match level {
        Level::ERROR => "error",
        Level::WARN => "warn",
        Level::INFO => "info",
        Level::DEBUG => "debug",
        _ => "trace",
    }
    .to_owned()
}

/// Splits a `tracing` event into its message and its structured fields.
#[derive(Default)]
struct FieldVisitor {
    message: Option<String>,
    fields: BTreeMap<String, String>,
}

impl FieldVisitor {
    fn put(&mut self, field: &Field, value: String) {
        if field.name() == "message" {
            self.message = Some(value);
        } else {
            self.fields.insert(field.name().to_owned(), value);
        }
    }
}

impl Visit for FieldVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field, value.to_owned());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.put(field, format!("{value:?}"));
    }
}
