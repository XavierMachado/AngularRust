# WebTransport lab

An Angular client and a Rust server that talk over WebTransport (HTTP/3 on QUIC), using all three
channels the protocol offers: bidirectional streams, unidirectional streams, and datagrams — and
over an ordinary WebSocket when QUIC cannot get through. The same server answers plain HTTP on the
same port number — a JSON API through the same handler the streams use, and the built app itself —
and the protocol logic is one Rust crate that the browser runs too, through wasm.

Both transports are the *same* application. There is one business layer, one session, one store and
one set of panels; what differs is only what genuinely differs, and the console says so rather than
papering over it.

The client isn't a wrapper around a demo — the whole app is the connection. Connecting, trusting
the certificate, framing messages, measuring round trips, and tearing down are all visible in the
UI as they happen.

```
client/      Angular 20, standalone components, zoneless, signals
client-lit/  the same console again: Lit 3, Shoelace, Vaadin Router, Vite, TC39 signals
backend/     Rust, wtransport 0.7, tokio, axum — the wt-server binary
shared/      Rust that runs on both sides: protocol, framing, lanes, validation, compute
wasm/        wasm-bindgen bindings over shared/, which both clients import
```

There are two frontends on purpose: the same application built twice, once on Angular and once on
a deliberately small stack, so the two can be compared like for like. The measurements and the
judgement calls are in [COMPARISON.md](COMPARISON.md).

The Rust side is one Cargo workspace. `shared/` must keep compiling for
`wasm32-unknown-unknown` — no tokio, no wtransport, no `SystemTime` — because the browser runs it
too; `make check` enforces that. `wasm/pkg` (the compiled output) is committed, so building the
client needs only Node; after changing `shared/` or `wasm/`, run `make wasm` and commit the result.

## Running it

Two terminals.

```bash
cargo run -p wt-server                  # udp/4433 WebTransport, tcp/4433 discovery
cd client && npm install && npm start   # http://localhost:4200  (Angular)
```

The Lit console runs the same way, on its own port, so both can be open at once against the one
server:

```bash
cd client-lit && npm install && npm run dev   # http://localhost:5273  (Lit)
```

Or via the Makefile: `make install`, then `make server` and `make client` (or `make client-lit`).

To serve a built frontend from the Rust server itself, point `STATIC_DIR` at whichever build you
want: the Angular one is picked up by default from `client/dist/console/browser`, the Lit one with
`STATIC_DIR=client-lit/dist cargo run -p wt-server`.

Other tasks:

```bash
cd client && npm test            # vitest, covers the framing logic
cd client-lit && npm test        # the same specs, plus a store spec, no harness
cd client && npm run format      # prettier (same command in client-lit)
cargo test --workspace           # framing, validation, compute
cargo clippy --workspace --all-targets
make check                       # all of the above
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

Firefox and Safari don't ship WebTransport yet, and plenty of networks block UDP. Either way the
console falls back to a WebSocket and keeps working — see [When QUIC is
blocked](#when-quic-is-blocked). The transport in use is named in the masthead, and the selector
beside it forces one or the other, which is the only way to exercise the fallback on a network
where QUIC is fine.

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

## Four lanes, two transports

The console thinks in *lanes*, not channels. A lane is a job; a channel is what a transport gives
you to do it with. WebTransport has a channel per lane, which is the luxurious case. A WebSocket
has exactly one, so the lanes share it.

| Lane | Used for | On WebTransport | On a WebSocket |
|---|---|---|---|
| Call | request → reply | a fresh bidirectional stream per call | lane `1`, correlated by id |
| Push | telemetry, broadcasts, notices, server logs | one server-opened unidirectional stream | lane `1`, same channel |
| Datagram | ping/pong round-trip timing | real QUIC datagrams | lane `2` — **emulated** |
| Upload | bulk bytes, backpressure included | a client-opened unidirectional stream | lanes `3`/`4`, raw bytes |

What each one actually promises:

| | WebTransport | WebSocket |
|---|---|---|
| Ordering between lanes | independent — a stalled upload does not delay a call | one ordered channel; bytes queue behind bytes |
| Datagram delivery | may be lost, may arrive out of order | never lost, never reordered |
| Upload backpressure | `writer.write()` resolves when flow control allows | poll `bufferedAmount` against a high-water mark |
| Concurrency of replies | separate streams | separate tasks on the server; the socket stays ordered |
| Certificate | trusted by fingerprint (see below) | the page's own TLS chain; no fingerprint involved |

The emulated row is the one worth dwelling on. Nothing sent on a WebSocket's datagram lane can be
dropped, so "Unanswered" can only ever read zero — which is why the console shows `n/a` there,
labels the lane *emulated*, and draws it dashed in the ledger. A perfect delivery rate there is a
statement about the socket, not about the network.

A QUIC stream is a byte pipe, not a message pipe: one read can hand you half a message or three of
them. Both sides therefore frame every message as a 4-byte big-endian length followed by JSON. The
format and the chunk-boundary bookkeeping live once, in `shared/src/framing.rs`; the backend adapts
it to QUIC streams in `backend/src/framing.rs`, and the client runs that same Rust through wasm
behind the facade in `client/src/app/core/framing.ts`. Datagrams need no framing — one datagram is
one message, and if it doesn't arrive, it doesn't.

The tag key differs per lane (`op` on calls, `kind` on pushes, `d` on datagrams, `t` on the envelope
that wraps the first two) so a message that shows up on the wrong one fails to parse instead of
half-working.

A WebSocket needs one thing more. Its messages are already delimited — one `send` is one `recv` —
so the length prefix would be pure overhead; what is missing is not the boundary but the *label*.
So every WebSocket message carries a nine-byte header instead:

```
byte 0      lane tag: 1 control, 2 datagram, 3 upload, 4 upload-end
bytes 1..9  stream id, u64 big-endian — which upload; zero on the other lanes
bytes 9..   body
```

That header is why bulk upload can stay raw. The alternative, wrapping the bytes in the JSON they
share a socket with, would base64 a megabyte into 1.4 MB. It lives in `shared/src/lane.rs`, is
tested there, and the browser runs the same compiled Rust through `client/src/app/core/lane.ts` —
the same arrangement as the framing codec.

## When QUIC is blocked

WebTransport needs UDP and QUIC. Corporate networks, older middleboxes and some VPNs block both,
and Firefox and Safari have no WebTransport at all. So the client negotiates:

1. `GET /discovery` says which transports the server offers, best first.
2. The client intersects that with what the browser can do and what the user picked in the
   selector — `Automatic`, `WebTransport only`, or `WebSocket only`.
3. It tries them in order. Every failure is written to the same event log as everything else, so
   the reason is visible rather than inferred.

On a network that drops UDP, `session.ready` does not reject — it hangs, sometimes for a minute.
That silence *is* the condition the fallback exists for, so the four-second deadline in
`webtransport-link.ts` is not a safety net; it is the trigger.

A dropped link is retried with exponential backoff from half a second, capped at eight and bounded
at five attempts. In `Automatic`, two consecutive WebTransport failures stop it paying that
deadline again and it continues over the WebSocket, saying so in the log.

The server degrades the same way. If the QUIC endpoint cannot bind — no IPv6 stack, udp/4433
already taken — it logs a warning, drops `webtransport` from what `/discovery` advertises, and
serves the WebSocket alone. Refusing to start would take the fallback down along with the thing it
stands in for.

**One caveat worth knowing:** a WebSocket upgrade is not subject to CORS. The permissive
`CorsLayer` does nothing for `/ws`, and any page anywhere can open it. Against localhost in
development that is the same exposure the rest of this listener already has; in production `/ws`
needs an explicit `Origin` check.

## The HTTP API, same port, same handler

tcp/4433 also speaks plain HTTP (`backend/src/http.rs`):

```
GET  /discovery      the fingerprint, the WebSocket URL, and which transports are offered
GET  /health         {"status":"ok"}
GET  /telemetry      the same numbers the push lane carries, same shape
POST /api/request    a Request in, a Reply out — the same op set as plain JSON
GET  /ws             the WebSocket fallback
```

`POST /api/request` deserializes the identical `Request` enum and calls the identical
`app::answer`, so no transport can drift from another — and it takes the request bare, exactly as
it did before there were two. The fun consequence is that transports compose:

```bash
curl -X POST http://127.0.0.1:4433/api/request \
  -H "Content-Type: application/json" \
  -d '{"op":"say","author":"curl","text":"hello from HTTP"}'
```

lands in the room of every connected browser — over WebTransport or over a WebSocket,
indifferently — because every path publishes to the same broadcast bus. The same `MAX_FIB` ceiling guards the one expensive request on both paths — it
lives in the shared crate, so neither transport can forget it.

When `client/dist/console/browser` exists (override with `STATIC_DIR`), the backend also serves the
built app, so `cargo run -p wt-server` after an `npm run build` is the whole production shape:
one process, one port number, app and API and WebTransport. In development the Angular dev server
on :4200 stays the front door for hot reload, and CORS on the API is permissive to allow it.

One caveat to know about: with the self-signed certificate, browser `fetch()` calls to
`https://…:4433` would fail TLS — `serverCertificateHashes` is a WebTransport-only escape hatch.
That is why this listener is plain HTTP in development. Under a real (or mkcert) certificate it
becomes HTTPS and the browser could call the API directly too.

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
- **Lanes.** `core/lane.ts` is the same arrangement for the WebSocket header, with a spec
  mirroring the Rust tests. Two implementations of one wire format is exactly what this repo
  avoids: what the browser tags a message with is byte-for-byte what the server expects, because
  it is the same function.
- **Validation.** `say()` runs the server's `validate_say` before sending, and the room panel
  previews the trim live. What the client refuses is what the server would refuse, by
  construction rather than by keeping two rule sets in sync.
- **Compute.** `fib` and the byte formatter are the shared functions; the request panel times the
  wasm call against the round trip.

The wasm module loads in `main.ts` before Angular boots, so every later call is synchronous. The
`.wasm` file itself is copied by an assets rule in `angular.json` and fetched once at startup
(~85 KB, ~30 KB over the wire).

The types in `core/protocol.ts` are still written by hand against `shared/src/protocol.rs` — the
logic no longer duplicates, the type declarations still do. Generating them (ts-rs or typeshare)
is the natural next step if that drift ever bites, and adding a second transport made that list
longer rather than shorter.

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
    protocol.rs   the message types and the call envelope, both directions
    framing.rs    the frame format and chunk-boundary decoder, plus its tests
    lane.rs       the WebSocket lane header, plus its tests
    validate.rs   the Say rules: trims, limits, the anonymous fallback
    compute.rs    fib, reverse, human_bytes

backend/            the wt-server binary
  src/
    main.rs       certificate, the listeners, graceful degradation when QUIC won't bind
    lib.rs        the module map, and why the pieces are split this way
    app.rs        the business layer: one Request in, one Reply out. Transport-free
    session.rs    what a session does, written once against a Link
    link.rs       the seam: a channel in, a channel out, and a label
    wt.rs         the WebTransport adapter: QUIC channels into the seam
    ws.rs         the WebSocket adapter: one channel, four lanes, into the same seam
    http.rs       discovery, /health, /telemetry, /api/request, /ws, static serving
    logging.rs    tracing layer that forwards log events to connected browsers
    framing.rs    the QUIC-stream adapters over the shared codec
    state.rs      counters, per-transport tallies, and the broadcast bus
    clock.rs      now_ms, kept out of shared/ because SystemTime panics on wasm
  tests/
    websocket.rs  the fallback end to end, against a real socket

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
      core/transport.service.ts   the store, and which transport carries it
      core/link.ts                what the console needs from a transport
      core/webtransport-link.ts   a channel per lane
      core/websocket-link.ts      four lanes on one channel
      core/negotiate.ts           which transport to try, and the backoff. Pure
      core/pending.ts             calls in flight, waiting on their correlation id
      core/net.ts                 the globals the transport touches, injectable
      core/framing.ts             facade over the shared codec, via wasm
      core/lane.ts                facade over the shared lane header, via wasm
      core/framing.spec.ts        the awkward chunk boundaries, run against the wasm
      core/lane.spec.ts           the lane header, run against the same wasm
      core/negotiate.spec.ts      the preference matrix and the backoff
      core/websocket-link.spec.ts the fallback link, driven by a fake socket
      core/wasm.ts                typed doorway to shared compute and validation
      core/protocol.ts            the messages, mirrored in TypeScript by hand
      core/webtransport.types.ts  browser API typings
      core/error-handler.ts       uncaught browser errors, into the same log
      panels/                     one component per lane, plus the log viewer
```

Tests cover `core/`, which runs under plain Node with no Angular or DOM — deliberately where the
logic that can be subtly wrong lives. The framing and lane specs exercise the committed wasm binary
itself; the WebSocket link is driven by a fake socket, which is what the injection seam in
`core/net.ts` exists to allow. On the Rust side, `backend/tests/websocket.rs` serves the real
router on an ephemeral port and drives it with a real client, so the fallback is tested end to end
rather than in pieces.

Component tests need a DOM and Angular's test harness; add the `@angular/build:unit-test` target to
`angular.json` when you want them. The WebTransport link has no automated test — driving it needs a
browser with a QUIC stack, so it is the one path still verified by hand.
