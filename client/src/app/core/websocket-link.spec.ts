import { beforeEach, describe, expect, it, vi } from 'vitest';

import { decodeLane, encodeControl, encodeDatagram, LANE, laneJson } from './lane';
import type { LinkEvents } from './link';
import type { Net } from './net';
import type { Discovery, ServerFrame, ServerPush } from './protocol';
import { WebSocketLink } from './websocket-link';

/**
 * A stand-in for the browser's WebSocket, recording what was sent and letting a
 * test decide what arrives. This is what the injection seam in `net.ts` buys:
 * before it, none of this file could exist without patching globals.
 */
class FakeSocket {
  static last: FakeSocket | null = null;

  readyState = 0;
  binaryType = '';
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];

  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { reason: string; wasClean: boolean }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ reason: 'closed', wasClean: true });
  }

  /** Completes the handshake, the way a real socket's open event would. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Delivers one binary message from the "server". */
  deliver(bytes: Uint8Array): void {
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }
}

const discovery: Discovery = {
  url: 'https://localhost:4433/lab',
  websocketUrl: 'ws://127.0.0.1:4433/ws',
  transports: ['webtransport', 'websocket'],
  certHash: [],
  certHashHex: '',
  maxCertificateDays: 14,
};

function net(): Net {
  return {
    fetchJson: async <T>() => ({}) as T,
    webTransport: null,
    webSocket: FakeSocket as unknown as Net['webSocket'],
  };
}

function events(): LinkEvents & { pushes: ServerPush[]; closed: string[] } {
  const pushes: ServerPush[] = [];
  const closed: string[] = [];

  return {
    pushes,
    closed,
    onPush: (push) => pushes.push(push),
    onPong: () => undefined,
    onTick: () => undefined,
    onNote: () => undefined,
    onClosed: (reason) => closed.push(reason),
  };
}

/** Opens a link with its handshake already completed. */
async function connected() {
  const link = new WebSocketLink(net());
  const sink = events();
  const opening = link.open(discovery, sink);

  // The constructor has run by now, so the socket exists to be opened.
  FakeSocket.last!.open();
  await opening;

  return { link, sink, socket: FakeSocket.last! };
}

/** The decoded control frames the client sent. */
function sentFrames(socket: FakeSocket) {
  return socket.sent
    .map((bytes) => decodeLane(bytes))
    .filter((decoded) => decoded.lane === LANE.control)
    .map((decoded) => laneJson<{ t: string; id: number }>(decoded.body));
}

describe('the WebSocket link', () => {
  beforeEach(() => {
    FakeSocket.last = null;
  });

  it('asks for binary frames, because every lane is binary', async () => {
    const { socket } = await connected();
    expect(socket.binaryType).toBe('arraybuffer');
  });

  it('correlates replies by id, whatever order they arrive in', async () => {
    const { link, socket } = await connected();

    const slow = link.call({ op: 'fib', n: 185 });
    const quick = link.call({ op: 'echo', text: 'hi' });

    const [first, second] = sentFrames(socket);
    expect(first.t).toBe('call');
    expect(second.id).not.toBe(first.id);

    // Answer the second one first: on one ordered channel, that is exactly the
    // case a correlation id exists to handle.
    const reply: ServerFrame = { t: 'result', id: second.id, reply: { op: 'echo', text: 'hi' } };
    socket.deliver(encodeControl(reply));

    await expect(quick).resolves.toEqual({ op: 'echo', text: 'hi' });

    socket.deliver(
      encodeControl({
        t: 'result',
        id: first.id,
        reply: { op: 'fib', n: 185, value: '1', tookMicros: 1 },
      } satisfies ServerFrame),
    );

    await expect(slow).resolves.toMatchObject({ op: 'fib' });
  });

  it('routes a push to the handler rather than to a waiting call', async () => {
    const { sink, socket } = await connected();

    socket.deliver(
      encodeControl({
        t: 'push',
        push: { kind: 'notice', text: 'hello' },
      } satisfies ServerFrame),
    );

    expect(sink.pushes).toEqual([{ kind: 'notice', text: 'hello' }]);
  });

  it('reads a pong off the datagram lane', async () => {
    const link = new WebSocketLink(net());
    const pongs: number[] = [];
    const sink = { ...events(), onPong: (pong: { seq: number }) => pongs.push(pong.seq) };

    const opening = link.open(discovery, sink);
    FakeSocket.last!.open();
    await opening;

    FakeSocket.last!.deliver(encodeDatagram({ d: 'pong', seq: 12, sentAtMs: 1, serverTimeMs: 2 }));

    expect(pongs).toEqual([12]);
  });

  it('sends an upload as raw lane messages ending in an upload-end', async () => {
    const { link, socket } = await connected();

    await link.upload(40 * 1024);

    const lanes = socket.sent.map((bytes) => decodeLane(bytes));
    const chunks = lanes.filter((decoded) => decoded.lane === LANE.upload);
    const ends = lanes.filter((decoded) => decoded.lane === LANE.uploadEnd);

    // 40 KiB at 16 KiB a chunk: two full and one partial.
    expect(chunks).toHaveLength(3);
    expect(chunks.reduce((total, chunk) => total + chunk.body.length, 0)).toBe(40 * 1024);
    expect(ends).toHaveLength(1);

    // All of it belongs to one upload, so the server can tally it as one.
    const stream = chunks[0].stream;
    expect(chunks.every((chunk) => chunk.stream === stream)).toBe(true);
    expect(ends[0].stream).toBe(stream);
  });

  it('waits for the send buffer to drain before writing more', async () => {
    vi.useFakeTimers();

    try {
      const { link, socket } = await connected();

      // Above the high-water mark, so the loop should stall rather than queue
      // the whole payload in memory.
      socket.bufferedAmount = 4 * 1024 * 1024;
      const upload = link.upload(64 * 1024);

      await vi.advanceTimersByTimeAsync(50);
      expect(socket.sent).toHaveLength(0);

      socket.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(50);
      await upload;

      expect(socket.sent.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects calls left in flight when the socket dies', async () => {
    const { link, sink, socket } = await connected();

    const pending = link.call({ op: 'ping' });
    socket.onclose?.({ reason: 'gone', wasClean: false });

    // A dead socket produces no per-call error of its own, so without this the
    // request would hang until its deadline.
    await expect(pending).rejects.toThrow(/gone/);
    expect(sink.closed).toHaveLength(1);
  });

  it('reports itself as emulating datagrams', async () => {
    const { link } = await connected();

    // The panels read this rather than comparing against the transport name.
    expect(link.datagramsAreEmulated).toBe(true);
    expect(link.kind).toBe('websocket');
  });
});
