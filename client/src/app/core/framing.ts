/**
 * Length-prefixed JSON framing, matching server/src/framing.rs.
 *
 * A stream chunk is whatever arrived in the last packet: it can hold part of a
 * frame, several frames, or a frame boundary in the middle of a number. The
 * decoder therefore keeps a buffer across chunks and only emits whole frames.
 */

const HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Serializes one value into a single frame. */
export function encodeFrame(value: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(value));

  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`Frame is ${body.length} bytes, over the ${MAX_FRAME_BYTES} limit`);
  }

  const frame = new Uint8Array(HEADER_BYTES + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, false);
  frame.set(body, HEADER_BYTES);

  return frame;
}

/** Accumulates stream chunks and emits complete frames. */
export class FrameDecoder {
  private pending = new Uint8Array(0);

  /** Feeds one chunk in, gets zero or more decoded frames out. */
  push<T>(chunk: Uint8Array): T[] {
    this.pending = concat(this.pending, chunk);

    const frames: T[] = [];

    for (;;) {
      if (this.pending.length < HEADER_BYTES) {
        break;
      }

      const view = new DataView(
        this.pending.buffer,
        this.pending.byteOffset,
        this.pending.byteLength,
      );
      const length = view.getUint32(0, false);

      if (length > MAX_FRAME_BYTES) {
        throw new Error(`Server announced a ${length} byte frame`);
      }

      if (this.pending.length < HEADER_BYTES + length) {
        break;
      }

      const body = this.pending.subarray(HEADER_BYTES, HEADER_BYTES + length);
      frames.push(JSON.parse(decoder.decode(body)) as T);

      this.pending = this.pending.slice(HEADER_BYTES + length);
    }

    return frames;
  }

  /** True when a partial frame is still buffered. */
  get hasPartialFrame(): boolean {
    return this.pending.length > 0;
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) {
    return right.slice();
  }

  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);

  return merged;
}
