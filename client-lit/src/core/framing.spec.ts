import { describe, expect, it } from 'vitest';

import { encodeFrame, FrameDecoder } from './framing';

/**
 * Framing is the one place a stream transport punishes optimism. A QUIC stream
 * hands over whatever arrived, so these tests feed the decoder the awkward
 * shapes on purpose: one frame arriving a byte at a time, several frames in one
 * chunk, and a length prefix split down the middle.
 */
describe('frame encoding', () => {
  it('prefixes the body with its length, big-endian', () => {
    const frame = encodeFrame({ op: 'ping' });
    const body = JSON.stringify({ op: 'ping' });

    const length = new DataView(frame.buffer, frame.byteOffset).getUint32(0, false);

    expect(length).toBe(body.length);
    expect(frame.length).toBe(4 + body.length);
  });

  it('round trips through the decoder', () => {
    const message = { op: 'echo', text: 'the quick brown fox' };
    const frames = new FrameDecoder().push<typeof message>(encodeFrame(message));

    expect(frames).toEqual([message]);
  });

  it('measures length in bytes, not characters', () => {
    // Four characters, twelve bytes. A character count here would truncate the
    // body and desynchronise every frame after it.
    const message = { text: '日本語で' };
    const frames = new FrameDecoder().push<typeof message>(encodeFrame(message));

    expect(frames).toEqual([message]);
  });
});

describe('frame decoding', () => {
  it('waits for a frame that arrives one byte at a time', () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ op: 'ping' });

    for (const byte of frame.subarray(0, frame.length - 1)) {
      expect(decoder.push(new Uint8Array([byte]))).toEqual([]);
    }

    expect(decoder.hasPartialFrame).toBe(true);
    expect(decoder.push(frame.subarray(frame.length - 1))).toEqual([{ op: 'ping' }]);
    expect(decoder.hasPartialFrame).toBe(false);
  });

  it('emits every frame in a chunk that holds several', () => {
    const decoder = new FrameDecoder();
    const parts = [encodeFrame({ n: 1 }), encodeFrame({ n: 2 }), encodeFrame({ n: 3 })];

    const merged = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }

    expect(decoder.push(merged)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('handles a chunk boundary inside the length prefix', () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ op: 'ping' });

    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.push(frame.subarray(2))).toEqual([{ op: 'ping' }]);
  });

  it('keeps the tail of a chunk that ends mid-frame', () => {
    const decoder = new FrameDecoder();
    const first = encodeFrame({ n: 1 });
    const second = encodeFrame({ n: 2 });

    const chunk = new Uint8Array(first.length + 3);
    chunk.set(first, 0);
    chunk.set(second.subarray(0, 3), first.length);

    expect(decoder.push(chunk)).toEqual([{ n: 1 }]);
    expect(decoder.push(second.subarray(3))).toEqual([{ n: 2 }]);
  });

  it('refuses an implausible length prefix instead of allocating for it', () => {
    const decoder = new FrameDecoder();
    const hostile = new Uint8Array(8);
    new DataView(hostile.buffer).setUint32(0, 0xffffffff, false);

    expect(() => decoder.push(hostile)).toThrow(/frame/i);
  });
});
