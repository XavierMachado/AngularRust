/**
 * Lane multiplexing — the same Rust the server runs, through wasm
 * (`shared/src/lane.rs` via `wasm/src/lib.rs`).
 *
 * A WebSocket is one channel and the console needs four, so every binary
 * message carries a nine-byte header saying which lane it belongs to. This is
 * a facade in the same spirit as `framing.ts`: bytes cross the wasm boundary as
 * Uint8Array, JSON is stringified and parsed on this side where the engine is
 * fastest, and the wire format itself is defined exactly once, in Rust.
 *
 * WebTransport never needs any of this. It has a channel per lane already.
 */

import { decode_lane, encode_lane } from 'wt-wasm';

/** The lane tags, mirroring `wt_shared::lane::Lane`. */
export const LANE = {
  control: 1,
  datagram: 2,
  upload: 3,
  uploadEnd: 4,
} as const;

export type LaneTag = (typeof LANE)[keyof typeof LANE];

export interface DecodedLane {
  lane: LaneTag;
  /** Which upload the body belongs to. Zero on the control and datagram lanes. */
  stream: number;
  body: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Wraps one JSON value for the control lane. */
export function encodeControl(value: unknown): Uint8Array {
  return encode_lane(LANE.control, 0, encoder.encode(JSON.stringify(value)));
}

/** Wraps one JSON value for the datagram lane. */
export function encodeDatagram(value: unknown): Uint8Array {
  return encode_lane(LANE.datagram, 0, encoder.encode(JSON.stringify(value)));
}

/** Wraps raw upload bytes. They stay raw: no base64, no JSON. */
export function encodeUpload(stream: number, bytes: Uint8Array): Uint8Array {
  return encode_lane(LANE.upload, stream, bytes);
}

/** Announces the end of an upload. No body. */
export function encodeUploadEnd(stream: number): Uint8Array {
  return encode_lane(LANE.uploadEnd, stream, new Uint8Array(0));
}

/**
 * Splits one received message into its lane, stream id and body.
 *
 * The wasm value is copied into a plain object and freed here rather than
 * handed out. wasm-bindgen registers its exports for finalization, so leaving
 * it to the collector would not leak forever — but it would leave wasm linear
 * memory held until a GC that has no idea it is under pressure, once per
 * inbound message, for the life of the session. Freeing on the spot is
 * deterministic and costs a call.
 */
export function decodeLane(message: Uint8Array): DecodedLane {
  const decoded = decode_lane(message);

  try {
    return {
      lane: decoded.lane as LaneTag,
      stream: decoded.stream,
      body: decoded.body,
    };
  } finally {
    decoded.free();
  }
}

/** Reads a control or datagram body as JSON. */
export function laneJson<T>(body: Uint8Array): T {
  return JSON.parse(decoder.decode(body)) as T;
}
