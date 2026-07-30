# Convenience only; both sides run fine with cargo and npm directly.
.PHONY: help server client install check fmt clean wasm

help:
	@echo "make install   install client dependencies"
	@echo "make server    run the WebTransport server (udp/4433, tcp/4433)"
	@echo "make client    run the Angular dev server (localhost:4200)"
	@echo "make wasm      rebuild wasm/pkg after changing shared/ or wasm/"
	@echo "make check     typecheck, lint and test everything"
	@echo "make fmt       format both sides"
	@echo "make clean     remove build output"
	@echo
	@echo "Run 'make server' and 'make client' in two terminals."

install:
	cd client && npm install

server:
	cargo run -p wt-server

client:
	cd client && npm start

check:
	cargo clippy --workspace --all-targets -- -D warnings
	cargo test --workspace
	cargo fmt --all --check
	# The guard rail: shared/ must keep compiling for the browser. This is
	# what fails if tokio, wtransport, or SystemTime creeps into it.
	cargo check -p wt-shared --target wasm32-unknown-unknown
	cd client && npm run test && npm run build

# wasm/pkg is committed so that a plain npm install works without the Rust
# toolchain. Rebuild and re-commit it whenever shared/ or wasm/ changes; the
# generated pkg/.gitignore would hide the output from git, so it goes.
wasm:
	wasm-pack build wasm --target web --out-dir pkg
	rm -f wasm/pkg/.gitignore

fmt:
	cargo fmt --all
	cd client && npx prettier --write "src/**/*.{ts,html,css}" vitest.setup.ts

clean:
	cargo clean
	rm -rf client/dist client/.angular client/coverage
