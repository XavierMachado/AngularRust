# Convenience only; every target below is a plain cargo or npm command you can
# run by hand. The point of having them here is that each rendition — server,
# Angular, Lit, hypermedia, desktop — can be run, tested and built on its own,
# without going through the whole suite to exercise one of them.
.PHONY: help install \
        server server-datastar serve-angular serve-lit \
        client client-lit client-datastar \
        desktop desktop-angular desktop-dev desktop-cef \
        test test-server test-client test-client-lit test-datastar \
        build build-client build-client-lit \
        check check-server check-client check-client-lit \
        wasm fmt clean

help:
	@echo "Setup"
	@echo "  make install          install dependencies for both SPA clients"
	@echo "  make wasm             rebuild wasm/pkg after changing shared/ or wasm/"
	@echo
	@echo "Run — one terminal each"
	@echo "  make server           the Rust server (udp/4433 + tcp/4433). Needed by everything"
	@echo "  make client           the Angular dev server      http://localhost:4200"
	@echo "  make client-lit       the Lit dev server          http://localhost:5273"
	@echo "  make server-datastar  the server WITH the hypermedia console at /ds"
	@echo "  make client-datastar  what that is and where its files live"
	@echo
	@echo "Run the production shape — one process serves the built app and the API"
	@echo "  make serve-angular    build the Angular client, then serve it from the server"
	@echo "  make serve-lit        build the Lit client, then serve it from the server"
	@echo
	@echo "Desktop — the console and the server as one executable"
	@echo "  make desktop-dev      run the desktop shell against the Lit build"
	@echo "  make desktop          bundle the desktop app around the Lit console"
	@echo "  make desktop-angular  bundle the desktop app around the Angular console"
	@echo "  make desktop-cef      bundle the experimental Chromium/CEF variant"
	@echo
	@echo "Test one at a time"
	@echo "  make test-server      cargo test: framing, validation, compute, the WS end to end"
	@echo "  make test-client      vitest in client/       (42 specs)"
	@echo "  make test-client-lit  vitest in client-lit/    (47 specs)"
	@echo "  make test-datastar    smoke-test /ds (needs make server-datastar running)"
	@echo "  make test             all of the above except test-datastar"
	@echo
	@echo "Lint, typecheck and build"
	@echo "  make check-server     clippy, cargo test, fmt --check, the wasm-target guard"
	@echo "  make check-client     vitest + production build, Angular"
	@echo "  make check-client-lit vitest + production build, Lit"
	@echo "  make check            all three"
	@echo "  make fmt              format every side"
	@echo "  make clean            remove build output"
	@echo
	@echo "Start with 'make server', then any one of the clients in a second terminal."

# Setup ----------------------------------------------------------------------

install:
	cd client && npm install
	cd client-lit && npm install

# wasm/pkg is committed so that a plain npm install works without the Rust
# toolchain. Rebuild and re-commit it whenever shared/ or wasm/ changes; the
# generated pkg/.gitignore would hide the output from git, so it goes.
wasm:
	wasm-pack build wasm --target web --out-dir pkg
	rm -f wasm/pkg/.gitignore

# Run ------------------------------------------------------------------------

server:
	cargo run -p wt-server

client:
	cd client && npm start

client-lit:
	cd client-lit && npm run dev

# The hypermedia console is a client, so it is off unless asked for: this is
# the server with `client-datastar/server.rs` compiled in and /ds mounted.
server-datastar:
	cargo run -p wt-server --features datastar

# There is no dev server to start for this one — the Rust server renders it.
# The target exists so `make help` can list all three clients together.
client-datastar:
	@echo "The hypermedia console has no dev server of its own: it is rendered by"
	@echo "wt-server, which mounts it only when asked."
	@echo
	@echo "    make server-datastar     then open http://127.0.0.1:4433/ds"
	@echo
	@echo "Its files are all in client-datastar/ — index.html, styles.css, the"
	@echo "vendored runtime, and server.rs, which is the half of this client that"
	@echo "the paradigm puts on the server. Override the directory with"
	@echo "DATASTAR_DIR. There is no build step: edit and reload."

# The production shape: one process, the built app and the API on one port.
serve-angular: build-client
	cargo run -p wt-server

serve-lit: build-client-lit
	STATIC_DIR=client-lit/dist cargo run -p wt-server

# Desktop --------------------------------------------------------------------
# Needs the platform webview toolchain; see the README. The desktop crates opt
# out of the Cargo workspace, so nothing above here requires any of it.

desktop-dev: build-client-lit
	cd desktop && npx @tauri-apps/cli dev

desktop: build-client-lit
	cd desktop && npx @tauri-apps/cli build

desktop-angular: build-client
	cd desktop && npx @tauri-apps/cli build --config tauri.angular.conf.json

# Experimental, and pinned to an unreleased Tauri branch: the first build
# downloads about a gigabyte of CEF. The CI workflow is the easier route.
desktop-cef: build-client-lit
	cd desktop/cef && cargo tauri build --bundles deb appimage

# Test -----------------------------------------------------------------------

test: test-server test-client test-client-lit

test-server:
	cargo test --workspace

test-client:
	cd client && npm test

test-client-lit:
	cd client-lit && npm test

# The hypermedia page has no unit tests of its own — its logic is the server's,
# covered by test-server. What is worth checking is that the three routes it
# needs answer, so this is a smoke test against a running server.
#
# Each check looks at what came back, not just the status: with the feature off
# these paths still answer 200, because the built SPA's deep-link fallback
# answers everything. Only the content tells the two apart.
test-datastar:
	@echo "Checking the hypermedia routes on http://127.0.0.1:4433 …"
	@curl -sf http://127.0.0.1:4433/ds | grep -q "data-signals" \
		&& echo "  /ds             the page          ok" \
		|| { echo "  /ds             FAILED — is 'make server-datastar' running?"; exit 1; }
	@curl -sf http://127.0.0.1:4433/ds/datastar.js | grep -q "Datastar" \
		&& echo "  /ds/datastar.js the runtime       ok" \
		|| { echo "  /ds/datastar.js FAILED — not the vendored runtime"; exit 1; }
	@curl -sf -N --max-time 2 http://127.0.0.1:4433/ds/stream | grep -q "datastar-merge-signals" \
		&& echo "  /ds/stream      the SSE stream    ok" \
		|| { echo "  /ds/stream      FAILED — no signals patch on the stream"; exit 1; }

# Build ----------------------------------------------------------------------

build: build-client build-client-lit

build-client:
	cd client && npm run build

build-client-lit:
	cd client-lit && npm run build

# Check ----------------------------------------------------------------------

check: check-server check-client check-client-lit

check-server:
	cargo clippy --workspace --all-targets -- -D warnings
	# The hypermedia client's server half is optional, so it needs checking
	# on purpose — nothing else in the workspace turns the feature on.
	cargo clippy -p wt-server --all-targets --features datastar -- -D warnings
	cargo test --workspace
	cargo fmt --all --check
	# The guard rail: shared/ must keep compiling for the browser. This is
	# what fails if tokio, wtransport, or SystemTime creeps into it.
	cargo check -p wt-shared --target wasm32-unknown-unknown

check-client:
	cd client && npm run test && npm run build

check-client-lit:
	cd client-lit && npm run test && npm run build

# Housekeeping ---------------------------------------------------------------

fmt:
	cargo fmt --all
	cd client && npx prettier --write "src/**/*.{ts,html,css}" vitest.setup.ts
	cd client-lit && npx prettier --write "src/**/*.{ts,css}" index.html vitest.setup.ts

clean:
	cargo clean
	rm -rf client/dist client/.angular client/coverage
	rm -rf client-lit/dist client-lit/node_modules/.vite
	rm -rf desktop/target/release/bundle desktop/cef/target/release/bundle
