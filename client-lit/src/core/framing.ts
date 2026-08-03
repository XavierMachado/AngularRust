/**
 * Length-prefixed JSON framing — the same Rust that frames on the server,
 * running here through wasm (`shared/src/framing.rs` via `wasm/src/lib.rs`).
 *
 * This file used to be a hand-written mirror of the Rust and is now a facade:
 * JSON stays on the JavaScript side, where the engine's own JSON.parse and
 * JSON.stringify are fastest, and bytes cross the boundary as Uint8Array. The
 * exported names and signatures are unchanged, which is why nothing that
 * imports them noticed the swap.
 */

import { WasmFrameDecoder, encode_frame } from 'wt-wasm';

/** Serializes one value into a single frame. */
export function encodeFrame(value: unknown): Uint8Array {
  return encode_frame(JSON.stringify(value));
}

/** Accumulates stream chunks and emits complete frames. */
export class FrameDecoder {
  private readonly inner = new WasmFrameDecoder();

  /** Feeds one chunk in, gets zero or more decoded frames out. */
  push<T>(chunk: Uint8Array): T[] {
    return this.inner.push(chunk).map((body) => JSON.parse(body) as T);
  }

  /** True when a partial frame is still buffered. */
  get hasPartialFrame(): boolean {
    return this.inner.has_partial_frame;
  }
}
