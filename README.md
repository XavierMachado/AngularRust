# WebTransport lab

An Angular client and a Rust server that talk over WebTransport (HTTP/3 on QUIC), using all three
channels the protocol offers: bidirectional streams, unidirectional streams, and datagrams.

The client isn't a wrapper around a demo — the whole app is the connection. Connecting, trusting
the certificate, framing messages, measuring round trips, and tearing down are all visible in the
UI as they happen.

```
client/   Angular 20, standalone components, zoneless, signals
backend/  Rust, wtransport 0.7, tokio, axum — the wt-server binary
shared/   Rust that runs on both sides: protocol, framing, validation, compute
wasm/     wasm-bindgen bindings over shared/, which the client imports
```

The Rust side is one Cargo workspace. `shared/` must keep compiling for
`wasm32-unknown-unknown` — no tokio, no wtransport, no `SystemTime` — because the browser runs it
too; `make check` enforces that. `wasm/pkg` (the compiled output) is committed, so building the
client needs only Node; after changing `shared/` or `wasm/`, run `make wasm` and commit the result.

## Running it

Two terminals.

```bash
cargo run -p wt-server                  # udp/4433 WebTransport, tcp/4433 discovery
cd client && npm install && npm start   # http://localhost:4200
```

Or via the Makefile: `make install`, then `make server` and `make client`.

Other tasks:

```bash
cd client && npm test        # vitest, covers the framing logic
cd client && npm run format  # prettier
cargo test --workspace       # framing, validation, compute
cargo clippy --workspace --all-targets
make check                   # all of the above
```

`Cargo.lock` is committed: this workspace builds a binary rather than a library, so pinning the
resolved dependency versions is what you want.

The toolchain is pinned in `rust-toolchain.toml`, and rustup installs it on the first build.
The pin has to be at least 1.88 — `wtransport` 0.7.1 declares that, and `rcgen` and `time` agree, so
an older pin fails during resolution rather than compilation, with a `not supported by the following
packages` error that looks unrelated to the compiler version.

On Windows, note that rustup's default *host* and your default *toolchain* are separate settings. If
the host is `x86_64-pc-windows-gnu`, the pin resolves to a GNU toolchain and the build needs a
complete mingw-w64 — an incomplete one fails at link time with `cannot find -l:libpthread.a`, often
because an unrelated mingw `gcc` is first on `PATH`. `rustup set default-host
x86_64-pc-windows-msvc` switches it, or build one-off with
`cargo +stable-x86_64-pc-windows-msvc run`.

Open <http://localhost:4200> in Chrome or Edge 97+, press **Connect**. Open a second tab to see the
room broadcast fan out across sessions.

Firefox and Safari don't ship WebTransport yet; the client says so instead of failing silently.

## The certificate problem, and how this handles it

A browser only opens a WebTransport session to a server it trusts, and in development there's no CA
to issue a certificate. The escape hatch is `serverCertificateHashes`: the client names one specific
certificate by its SHA-256 fingerprint. Chrome accepts that only when the certificate uses ECDSA
P-256 and is valid for 14 days or less, which is exactly what `Identity::self_signed` produces.

The fingerprint changes on every server start, so pasting it into config would break constantly.
Instead the server publishes it over plain HTTP:

```
GET http://127.0.0.1:4433/discovery
{ "url": "https://localhost:4433/lab", "certHash": [12, 34, ...], "certHashHex": "0c22...", ... }
```

The client fetches that first, then opens the session. Nothing to copy, nothing to expire.

**This is a development shortcut.** In production the server holds a normal CA-issued certificate,
the client passes no hashes at all, and the discovery endpoint disappears along with its permissive
CORS layer.

## How the three channels are used

| Channel | Guarantees | Used for |
|---|---|---|
| Bidirectional stream | ordered, retransmitted, flow-controlled | request → reply; a fresh stream per request |
| Unidirectional stream (client → server) | same, one way | bulk upload, backpressure included |
| Unidirectional stream (server → client) | same, one way | telemetry, broadcasts, notices, server logs |
| Datagram | none of the above | ping/pong round-trip timing |

A QUIC stream is a byte pipe, not a message pipe: one read can hand you half a message or three of
them. Both sides therefore frame every message as a 4-byte big-endian length followed by JSON. The
format and the chunk-boundary bookkeeping live once, in `shared/src/framing.rs`; the backend adapts
it to QUIC streams in `backend/src/framing.rs`, and the client currently mirrors it in TypeScript
(`client/src/app/core/framing.ts`) until the wasm bindings replace that mirror. Datagrams need no
framing — one datagram is one message, and if it doesn't arrive, it doesn't.

The tag key differs per channel (`op` on request streams, `kind` on the push stream, `d` on
datagrams) so a message that shows up on the wrong channel fails to parse instead of half-working.

## Server logs in the browser

A `tracing` layer sits beside the usual stdout formatter and copies events onto the same broadcast
bus that carries telemetry, so the console shows the server's own account of what happened rather
than the client's guess at it. Client-side events and forwarded server records land on one timeline,
sorted by time, filterable by level, side and text, with a Copy button that produces a plain text
transcript ready to paste into an issue.

Records carry their `tracing` level, module path, structured fields, and the session they belong to,
so `s003` in the filter box narrows everything to one connection across both sides.

Three details that matter more than they look:

- **The loop.** Forwarding a log line means writing to a QUIC stream, and writing to a QUIC stream
  can emit log lines. A tokio task-local marker is set for the lifetime of each session's push task
  and the layer drops anything emitted inside it. A thread-local would not survive the `.await`
  points; a task-local does.
- **Replay.** The last 250 records are kept and sent to each session as it connects, so a browser
  opened after the interesting thing happened still sees it. Records carry a sequence number and the
  server carries a boot id, so the client can drop what it has already shown and still notice when
  the numbering restarts.
- **What gets forwarded.** This crate's events at any level, plus warnings and errors from anywhere.
  The transport stack's own targets are muted outright — under load, quinn describes every packet it
  touches. `RUST_LOG` still controls the terminal and the browser together.

Uncaught browser exceptions and unhandled promise rejections go to the same panel through a custom
`ErrorHandler`. A stream read that rejects inside a `void`-ed async call has nowhere else to go.

One thing to know before pointing this at anything real: each forwarded record is written once per
connected session, and the bus is bounded. A session that falls behind loses records and is told so
in the log rather than left with a silent gap.

## Reading the UI

The ledger across the top is a twenty-second window of the connection. Reliable stream traffic ticks
upward in teal, datagrams tick downward in magenta, outbound solid and inbound hollow. Every panel
is colour-coded by which transport it uses, so which guarantee you're getting is legible before you
read anything.

Things worth trying:

- Start `fib(185)` and press Echo immediately. The echo comes back first — separate streams, no
  head-of-line blocking between them.
- Press **On the server** and then **In this tab** for the same `n`. The identical digits come
  back, because it is the identical Rust function — one call crossed the network, the other ran in
  the page through wasm.
- Turn on the twice-a-second ping, then upload 16 MiB. Datagram round trips climb while the stream
  saturates the link, and some pings never return. Both are the transport behaving correctly.
- Kill the server while connected. `closed` rejects, the log says so, and the UI returns to offline
  without a stale session hanging around. The **In this tab** button keeps working — it never
  needed the connection.

## The same Rust in the browser

`shared/` compiles twice: natively into the server, and through `wasm/` (wasm-bindgen) into the
page. The split of labor at the boundary is deliberate: bytes cross as `Uint8Array`, JSON crosses
as strings — the engine's own `JSON.parse` beats marshalling structured values through wasm — and
everything stateful stays on the Rust side of the line.

What the client actually runs through it:

- **Framing.** `core/framing.ts` keeps its old two-symbol surface (`encodeFrame`, `FrameDecoder`)
  but is now a facade over the shared codec. The vitest spec that used to test the TypeScript
  implementation now tests the compiled binary — `vitest.setup.ts` loads the committed `.wasm`
  with `initSync`, so the same eight tests pin both implementations to one behavior.
- **Validation.** `say()` runs the server's `validate_say` before sending, and the room panel
  previews the trim live. What the client refuses is what the server would refuse, by
  construction rather than by keeping two rule sets in sync.
- **Compute.** `fib` and the byte formatter are the shared functions; the request panel times the
  wasm call against the round trip.

The wasm module loads in `main.ts` before Angular boots, so every later call is synchronous. The
`.wasm` file itself is copied by an assets rule in `angular.json` and fetched once at startup
(~84 KB, ~30 KB over the wire).

The types in `core/protocol.ts` are still written by hand against `shared/src/protocol.rs` — the
logic no longer duplicates, the type declarations still do. Generating them (ts-rs or typeshare)
is the natural next step if that drift ever bites.

## Notes on the code

**Zoneless Angular.** Everything arrives through `ReadableStream` readers and promise chains that
zone.js doesn't reliably patch. Signals notify Angular directly, so the UI tracks the connection
without a zone in the middle. On Angular 18/19 the provider is
`provideExperimentalZonelessChangeDetection`.

**WebTransport typings.** `client/src/app/core/webtransport.types.ts` declares structural `Wt*`
interfaces rather than augmenting the global scope. Whether `lib.dom.d.ts` ships WebTransport types
depends on the TypeScript version, and a global `declare` that collides with a built-in one breaks
on a routine TypeScript bump.

**Stream lifecycle.** The server calls `finish()` on send streams rather than dropping them. A
dropped stream can reach the peer as a reset, which discards data still sitting in its receive
buffer — so a reply that was definitely written can still vanish. The client drains each reply
stream to EOF for the same reason.

**wtransport version.** Pinned to 0.7. On 0.6.x, `ServerConfig::builder().with_identity()` takes a
reference: `.with_identity(&identity)`.

## Layout

```
.editorconfig       shared whitespace rules for both sides
.gitignore          build output on both sides; Cargo.lock is deliberately kept
Makefile            run, test and format targets
Cargo.toml          the workspace: backend, shared, wasm
Cargo.lock          committed, because this workspace builds a binary
rust-toolchain.toml pinned compiler, with rustfmt and clippy
rustfmt.toml

shared/             code that runs on the server and, through wasm, in the browser
  src/
    protocol.rs   the message types, serializable in both directions
    framing.rs    the frame format and chunk-boundary decoder, plus its tests
    validate.rs   the Say rules: trims, limits, the anonymous fallback
    compute.rs    fib, reverse, human_bytes

backend/            the wt-server binary
  src/
    main.rs       certificate, discovery endpoint, accept loop
    session.rs    per-session: bidi requests, uploads, datagrams, push stream
    logging.rs    tracing layer that forwards log events to connected browsers
    framing.rs    the QUIC-stream adapters over the shared codec
    state.rs      counters and the broadcast bus
    clock.rs      now_ms, kept out of shared/ because SystemTime panics on wasm

wasm/               what the browser imports
  src/lib.rs      thin wasm-bindgen casts around shared/ — no logic of its own
  pkg/            wasm-pack output, committed; `make wasm` regenerates it

client/
  package.json          scripts: start, build, test, format; depends on file:../wasm/pkg
  angular.json          application and dev-server targets; copies the .wasm asset
  tsconfig.json         strict, plus strict Angular templates
  tsconfig.app.json     the build
  tsconfig.spec.json    the tests
  vitest.config.ts
  vitest.setup.ts       instantiates the committed wasm for the tests
  .prettierrc
  public/favicon.svg
  src/
    index.html
    main.ts             loads the wasm module, then boots Angular
    styles.css          the design tokens live here
    app/
      app.config.ts               zoneless, plus the global error handler
      app.ts                      layout, masthead, telemetry strip
      core/transport.service.ts   owns the session, exposes it as signals
      core/framing.ts             facade over the shared codec, via wasm
      core/framing.spec.ts        the awkward chunk boundaries, run against the wasm
      core/wasm.ts                typed doorway to shared compute and validation
      core/protocol.ts            the messages, mirrored in TypeScript by hand
      core/webtransport.types.ts  browser API typings
      core/error-handler.ts       uncaught browser errors, into the same log
      panels/                     one component per channel, plus the log viewer
```

Tests cover `core/`, which runs under plain Node with no Angular or DOM — deliberately where the
logic that can be subtly wrong lives. The framing spec exercises the committed wasm binary itself.
Component tests need a DOM and Angular's test harness; add the `@angular/build:unit-test` target to
`angular.json` when you want them.
