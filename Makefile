# Convenience only; every target below is a plain cargo or npm command you can
# run by hand. The point of having them here is that each rendition — server,
# Angular, Lit, hypermedia, desktop — can be run, tested and built on its own,
# without going through the whole suite to exercise one of them.
.PHONY: help install \
        server serve-angular serve-lit \
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
	@echo "  make client-datastar  where the hypermedia page lives (the server serves it)"
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
	@echo "  make test-datastar    smoke-test the hypermedia routes (needs make server running)"
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

# There is nothing to start: the server renders this one. The target exists so
# `make help` can list all three clients in one place and say where it lives.
client-datastar:
	@echo "The hypermedia console needs no dev server — the running wt-server serves it:"
	@echo
	@echo "    http://127.0.0.1:4433/ds"
	@echo
	@echo "Its files are in client-datastar/ (override with DATASTAR_DIR). There is no"
	@echo "build step: edit index.html or styles.css and reload the page."

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
test-datastar:
	@echo "Checking the hypermedia routes on http://127.0.0.1:4433 …"
	@curl -sf -o /dev/null http://127.0.0.1:4433/ds \
		&& echo "  /ds             the page          ok" \
		|| { echo "  /ds             FAILED — is 'make server' running?"; exit 1; }
	@curl -sf -o /dev/null http://127.0.0.1:4433/ds/datastar.js \
		&& echo "  /ds/datastar.js the runtime       ok" \
		|| { echo "  /ds/datastar.js FAILED"; exit 1; }
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
