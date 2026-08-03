import { beforeEach, describe, expect, it, vi } from 'vitest';

import { decodeLane, encodeControl, LANE, laneJson } from '../core/lane';
import type { Net } from '../core/net';
import type { Discovery, ServerFrame } from '../core/protocol';
import { TransportStore } from './transport';

/**
 * Drives the whole store — negotiation, adoption, reducers — under plain Node,
 * with the same fake socket the link spec uses. No test harness, no DI
 * container: the store is a class that takes a `Net`, so a test just hands it
 * one.
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

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(bytes: Uint8Array): void {
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }
}

const discovery: Discovery = {
  url: 'https://localhost:4433/lab',
  websocketUrl: 'ws://127.0.0.1:4433/ws',
  transports: ['websocket'],
  certHash: [],
  certHashHex: 'ab:cd',
  maxCertificateDays: 14,
};

function net(): Net {
  return {
    fetchJson: async <T>() => discovery as T,
    webTransport: null,
    webSocket: FakeSocket as unknown as Net['webSocket'],
  };
}

/** A store connected over the fake socket, welcome already delivered. */
async function connected() {
  const store = new TransportStore(net(), 'http://test/discovery');
  const connecting = store.connect('tester');

  await vi.waitFor(() => {
    if (!FakeSocket.last) {
      throw new Error('socket not yet constructed');
    }
  });

  const socket = FakeSocket.last!;
  socket.open();
  await connecting;

  socket.deliver(
    encodeControl({
      t: 'push',
      push: {
        kind: 'welcome',
        sessionId: 's007',
        motd: 'hello',
        boot: 'boot-1',
        transport: 'websocket',
      },
    } satisfies ServerFrame),
  );

  return { store, socket };
}

/** The decoded control frames the client sent. */
function sentFrames(socket: FakeSocket) {
  return socket.sent
    .map((bytes) => decodeLane(bytes))
    .filter((decoded) => decoded.lane === LANE.control)
    .map((decoded) => laneJson<{ t: string; id: number }>(decoded.body));
}

describe('the transport store', () => {
  beforeEach(() => {
    FakeSocket.last = null;
  });

  it('negotiates, adopts the socket and applies the welcome', async () => {
    const { store } = await connected();

    expect(store.state.get()).toBe('online');
    expect(store.online.get()).toBe(true);
    expect(store.transport.get()).toBe('websocket');
    expect(store.datagramsEmulated.get()).toBe(true);
    expect(store.sessionId.get()).toBe('s007');
    expect(store.motd.get()).toBe('hello');
    expect(store.fingerprint.get()).toBe('ab:cd');
  });

  it('reduces a said push into the room, marking its own lines', async () => {
    const { store, socket } = await connected();

    for (const author of ['tester', 'someone else']) {
      socket.deliver(
        encodeControl({
          t: 'push',
          push: { kind: 'said', author, text: 'hi', atMs: 1 },
        } satisfies ServerFrame),
      );
    }

    const room = store.room.get();
    expect(room.map((line) => line.mine)).toEqual([true, false]);
  });

  it('runs say through the shared validation before it leaves the tab', async () => {
    const { store, socket } = await connected();

    const saying = store.say('  padded  ');
    await vi.waitFor(() => {
      if (!sentFrames(socket).length) {
        throw new Error('nothing sent yet');
      }
    });

    const [frame] = sentFrames(socket);
    const call = frame as unknown as { request: { op: string; text: string } };
    expect(call.request).toMatchObject({ op: 'say', text: 'padded' });

    socket.deliver(
      encodeControl({ t: 'result', id: frame.id, reply: { op: 'accepted' } } satisfies ServerFrame),
    );
    await saying;
  });

  it('dedupes forwarded server log records by seq until the boot changes', async () => {
    const { store, socket } = await connected();
    const record = { kind: 'log', seq: 9, atMs: 1, level: 'info', target: 'wt', message: 'x' };

    const serverLines = () => store.log.get().filter((line) => line.origin === 'server').length;

    socket.deliver(encodeControl({ t: 'push', push: record } as unknown as ServerFrame));
    socket.deliver(encodeControl({ t: 'push', push: record } as unknown as ServerFrame));
    expect(serverLines()).toBe(1);

    // A new boot id means the server's sequence numbers started over.
    socket.deliver(
      encodeControl({
        t: 'push',
        push: {
          kind: 'welcome',
          sessionId: 's007',
          motd: 'hello',
          boot: 'boot-2',
          transport: 'websocket',
        },
      } satisfies ServerFrame),
    );
    socket.deliver(encodeControl({ t: 'push', push: record } as unknown as ServerFrame));
    expect(serverLines()).toBe(2);
  });

  it('goes back to offline on disconnect without scheduling a retry', async () => {
    const { store } = await connected();

    store.disconnect();

    expect(store.state.get()).toBe('offline');
    expect(store.sessionId.get()).toBe(null);
    expect(store.telemetry.get()).toBe(null);
  });
});
