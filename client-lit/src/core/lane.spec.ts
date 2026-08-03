import { describe, expect, it } from 'vitest';

import {
  decodeLane,
  encodeControl,
  encodeDatagram,
  encodeUpload,
  encodeUploadEnd,
  LANE,
  laneJson,
} from './lane';

/**
 * These mirror the Rust tests in `shared/src/lane.rs`, and run against the same
 * compiled wasm the browser loads. Two implementations of one wire format is
 * exactly what this repo avoids, so the point of testing here is not to check a
 * second implementation — it is to check that the boundary between JavaScript
 * and the one implementation does not mangle anything on the way through.
 */
describe('lane encoding', () => {
  it('puts the tag first, then a big-endian stream id', () => {
    const message = encodeUpload(0x01020304, new Uint8Array([0xaa, 0xbb]));

    expect(Array.from(message)).toEqual([LANE.upload, 0, 0, 0, 0, 1, 2, 3, 4, 0xaa, 0xbb]);
  });

  it('round trips a control frame', () => {
    const frame = { t: 'call', id: 7, request: { op: 'ping' } };
    const decoded = decodeLane(encodeControl(frame));

    expect(decoded.lane).toBe(LANE.control);
    expect(decoded.stream).toBe(0);
    expect(laneJson(decoded.body)).toEqual(frame);
  });

  it('round trips a datagram', () => {
    const ping = { d: 'ping', seq: 3, sentAtMs: 1234.5 };
    const decoded = decodeLane(encodeDatagram(ping));

    expect(decoded.lane).toBe(LANE.datagram);
    expect(laneJson(decoded.body)).toEqual(ping);
  });

  it('keeps upload bytes raw and byte-identical', () => {
    // A repeating pattern rather than zeroes, so a truncation or an off-by-one
    // in the header would show up as changed content rather than fewer zeroes.
    const payload = new Uint8Array(16 * 1024);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = index % 251;
    }

    const decoded = decodeLane(encodeUpload(9, payload));

    expect(decoded.lane).toBe(LANE.upload);
    expect(decoded.stream).toBe(9);
    expect(decoded.body).toEqual(payload);
  });

  it('carries an empty body for the end of an upload', () => {
    const decoded = decodeLane(encodeUploadEnd(4));

    expect(decoded.lane).toBe(LANE.uploadEnd);
    expect(decoded.stream).toBe(4);
    expect(decoded.body.length).toBe(0);
  });

  it('measures the JSON body in bytes, not characters', () => {
    // Four characters, twelve bytes. Getting this wrong would truncate the tail
    // of every message containing anything outside ASCII.
    const decoded = decodeLane(encodeControl({ text: '日本語' }));

    expect(decoded.body.length).toBe(new TextEncoder().encode('{"text":"日本語"}').length);
    expect(laneJson(decoded.body)).toEqual({ text: '日本語' });
  });

  it('refuses a header cut short instead of reading past it', () => {
    // Eight bytes: one short of a header, so the stream id would run off the end.
    expect(() => decodeLane(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]))).toThrow();
    expect(() => decodeLane(new Uint8Array(0))).toThrow();
  });

  it('refuses a lane tag it does not know rather than guessing', () => {
    const message = encodeControl({});
    message[0] = 9;

    expect(() => decodeLane(message)).toThrow();
  });
});
