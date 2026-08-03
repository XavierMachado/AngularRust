import { beforeEach, describe, expect, it } from 'vitest';

import type { LinkEvents } from './link';
import type { Net } from './net';
import type { DatagramOut, Discovery, Reply, ServerPush } from './protocol';
import type { TauriIpc } from './tauri-ipc';
import { TauriIpcLink } from './tauri-link';

/**
 * A stand-in for the desktop shell's IPC doorway, recording what was invoked
 * and letting a test play the server's events. The same seam in `net.ts` that
 * makes the WebSocket link testable makes this one testable — no Tauri
 * runtime anywhere near the test.
 */
class FakeIpc implements TauriIpc {
  readonly invoked: { command: string; payload?: unknown; headers?: Record<string, string> }[] = [];
  readonly handlers = new Map<string, (event: { payload: unknown }) => void>();
  readonly stopped: string[] = [];
  replies: Reply[] = [];

  async invoke<T>(
    command: string,
    payload?: unknown,
    options?: { headers?: Record<string, string> },
  ): Promise<T> {
    this.invoked.push({ command, payload, ...(options?.headers && { headers: options.headers }) });

    if (command === 'ipc_call') {
      return (this.replies.shift() ?? { op: 'accepted' }) as T;
    }

    return undefined as T;
  }

  async listen(event: string, handler: (event: { payload: unknown }) => void) {
    this.handlers.set(event, handler);
    return () => {
      this.stopped.push(event);
    };
  }

  emit(event: string, payload: unknown): void {
    this.handlers.get(event)?.({ payload });
  }
}

const discovery: Discovery = {
  url: '',
  websocketUrl: '',
  transports: ['ipc'],
  certHash: [],
  certHashHex: '',
  maxCertificateDays: 0,
};

function net(ipc: TauriIpc | null): Net {
  return {
    fetchJson: async <T>() => ({}) as T,
    webTransport: null,
    webSocket: null,
    tauriIpc: ipc,
  };
}

function events(): LinkEvents & { pushes: ServerPush[]; pongs: DatagramOut[]; closed: string[] } {
  const pushes: ServerPush[] = [];
  const pongs: DatagramOut[] = [];
  const closed: string[] = [];

  return {
    pushes,
    pongs,
    closed,
    onPush: (push) => pushes.push(push),
    onPong: (pong) => pongs.push(pong),
    onTick: () => undefined,
    onNote: () => undefined,
    onClosed: (reason) => closed.push(reason),
  };
}

async function connected() {
  const ipc = new FakeIpc();
  const link = new TauriIpcLink(net(ipc));
  const sink = events();

  await link.open(discovery, sink);

  return { ipc, link, sink };
}

describe('the Tauri IPC link', () => {
  let context: Awaited<ReturnType<typeof connected>>;

  beforeEach(async () => {
    context = await connected();
  });

  it('refuses to open outside the desktop shell', async () => {
    const link = new TauriIpcLink(net(null));

    await expect(link.open(discovery, events())).rejects.toThrow(/desktop shell/);
  });

  it('subscribes before it connects, so the welcome cannot be missed', () => {
    const { ipc } = context;

    expect([...ipc.handlers.keys()]).toEqual(['ipc:push', 'ipc:datagram']);
    expect(ipc.invoked.map((entry) => entry.command)).toEqual(['ipc_connect']);
  });

  it('resolves a call with the reply the invoke returned — no correlation ids', async () => {
    const { ipc, link } = context;
    ipc.replies = [{ op: 'echo', text: 'hi' }];

    await expect(link.call({ op: 'echo', text: 'hi' })).resolves.toEqual({
      op: 'echo',
      text: 'hi',
    });
  });

  it('routes a push to the handler', () => {
    const { ipc, sink } = context;

    ipc.emit('ipc:push', { kind: 'notice', text: 'hello' });

    expect(sink.pushes).toEqual([{ kind: 'notice', text: 'hello' }]);
  });

  it('reads a pong off the datagram event', () => {
    const { ipc, sink } = context;

    ipc.emit('ipc:datagram', { d: 'pong', seq: 9, sentAtMs: 1, serverTimeMs: 2 });

    expect(sink.pongs).toEqual([{ d: 'pong', seq: 9, sentAtMs: 1, serverTimeMs: 2 }]);
  });

  it('uploads raw chunks under one id, then ends that id', async () => {
    const { ipc, link } = context;

    await link.upload(40 * 1024);

    const chunks = ipc.invoked.filter((entry) => entry.command === 'ipc_upload_chunk');
    const ends = ipc.invoked.filter((entry) => entry.command === 'ipc_upload_end');

    // 40 KiB at 16 KiB a chunk: two full and one partial.
    expect(chunks).toHaveLength(3);
    expect(
      chunks.reduce((total, entry) => total + (entry.payload as Uint8Array).byteLength, 0),
    ).toBe(40 * 1024);

    const id = chunks[0].headers?.['x-upload-id'];
    expect(id).toBeDefined();
    expect(chunks.every((entry) => entry.headers?.['x-upload-id'] === id)).toBe(true);
    expect(ends).toEqual([{ command: 'ipc_upload_end', payload: { id: Number(id) } }]);
  });

  it('closes once: disconnects, unsubscribes, reports', () => {
    const { ipc, link, sink } = context;

    link.close();
    link.close();

    expect(ipc.invoked.map((entry) => entry.command)).toContain('ipc_disconnect');
    expect(ipc.stopped).toEqual(['ipc:push', 'ipc:datagram']);
    expect(sink.closed).toHaveLength(1);
  });
});
