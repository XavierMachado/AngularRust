# Convenience only; both sides run fine with cargo and npm directly.
.PHONY: help server client install check fmt clean

help:
	@echo "make install   install client dependencies"
	@echo "make server    run the WebTransport server (udp/4433, tcp/4433)"
	@echo "make client    run the Angular dev server (localhost:4200)"
	@echo "make check     typecheck and lint-build both sides"
	@echo "make fmt       format both sides"
	@echo "make clean     remove build output"
	@echo
	@echo "Run 'make server' and 'make client' in two terminals."

install:
	cd client && npm install

server:
	cd server && cargo run

client:
	cd client && npm start

check:
	cd server && cargo clippy --all-targets -- -D warnings && cargo test
	cd client && npm run test && npm run build

fmt:
	cd server && cargo fmt
	cd client && npx prettier --write "src/**/*.{ts,html,css}"

clean:
	cd server && cargo clean
	rm -rf client/dist client/.angular client/coverage
