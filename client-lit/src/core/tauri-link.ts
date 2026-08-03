/**
 * The IPC link: the same session, with no wire at all.
 *
 * Inside the desktop shell the server shares the process, so this link's
 * "transport" is Tauri's command and event system. Two whole layers the
 * network links need simply vanish: there is no framing, because nothing is
 * ever bytes on a wire, and there are no correlation ids, because an `invoke`
 * promise is its own correlation — the reply resolves the call that made it.
 *
 * What the round-trip numbers measure here is the cost of crossing the
 * webview boundary: serialization in, serialization out, and nothing between.
 */

import { describe, formatBytes, type Link, type LinkEvents } from './link';
import type { Net } from './net';
import type {
  DatagramIn,
  DatagramOut,
  Discovery,
  Reply,
  Request,
  ServerPush,
  TransportKind,
} from './protocol';
import type { TauriIpc } from './tauri-ipc';

const UPLOAD_CHUNK = 16 * 1024;

export class TauriIpcLink implements Link {
  readonly kind: TransportKind = 'ipc';
  /** No channel here can lose anything, so the datagram lane is an emulation. */
  readonly datagramsAreEmulated = true;

  private ipc: TauriIpc | null = null;
  private events: LinkEvents | null = null;
  private readonly unlisten: (() => void)[] = [];
  private nextUpload = 1;
  private ended = false;

  constructor(private readonly net: Net) {}

  get endpoint(): string {
    return 'in-process · tauri ipc';
  }

  async open(_discovery: Discovery, events: LinkEvents): Promise<void> {
    const ipc = this.net.tauriIpc;
    if (!ipc) {
      throw new Error('The in-process channel only exists inside the desktop shell.');
    }

    this.events = events;

    // Subscribe before connecting, so the welcome cannot arrive unheard.
    try {
      this.unlisten.push(
        await ipc.listen('ipc:push', ({ payload }) => {
          this.events?.onTick('stream', 'in', 0.6);
          this.events?.onPush(payload as ServerPush);
        }),
        await ipc.listen('ipc:datagram', ({ payload }) => {
          this.events?.onTick('datagram', 'in', 0.5);
          const pong = payload as DatagramOut;

          if (pong.d === 'pong') {
            this.events?.onPong(pong);
          }
        }),
      );

      await ipc.invoke<string>('ipc_connect');
    } catch (error) {
      this.detach();
      throw new Error(describe(error));
    }

    this.ipc = ipc;
  }

  async call(request: Request): Promise<Reply> {
    const ipc = this.require();
    this.events?.onTick('stream', 'out');

    try {
      // No deadline: the answering task is in this process, and if it were
      // wedged, a timer here would be the least of anyone's problems.
      return await ipc.invoke<Reply>('ipc_call', { request });
    } catch (error) {
      throw new Error(describe(error));
    }
  }

  async sendDatagram(datagram: DatagramIn): Promise<void> {
    const ipc = this.require();

    await ipc.invoke('ipc_datagram', { datagram });
    this.events?.onTick('datagram', 'out', 0.5);
  }

  async upload(totalBytes: number): Promise<void> {
    const ipc = this.require();
    const id = this.nextUpload++;

    const chunk = new Uint8Array(UPLOAD_CHUNK);
    crypto.getRandomValues(chunk);

    let sent = 0;

    try {
      while (sent < totalBytes) {
        const size = Math.min(chunk.length, totalBytes - sent);

        // A raw byte payload, so the rate the panel reports measures a real
        // transfer across the IPC boundary. Awaiting each chunk is the flow
        // control: nothing is ever queued that the other side has not taken.
        await ipc.invoke('ipc_upload_chunk', chunk.subarray(0, size), {
          headers: { 'x-upload-id': String(id) },
        });

        sent += size;
        this.events?.onTick('stream', 'out', 0.9);
      }

      await ipc.invoke('ipc_upload_end', { id });
      this.events?.onNote('stream', `Sent ${formatBytes(totalBytes)} across the process boundary`);
    } catch (error) {
      throw new Error(describe(error));
    }
  }

  close(): void {
    void this.ipc?.invoke('ipc_disconnect').catch(() => undefined);
    this.finish('IPC session closed', 'info');
  }

  private require(): TauriIpc {
    if (!this.ipc || this.ended) {
      throw new Error('Not connected');
    }

    return this.ipc;
  }

  private finish(reason: string, level: 'info' | 'warn'): void {
    if (this.ended) {
      return;
    }

    this.ended = true;
    this.detach();
    this.events?.onClosed(reason, level);
  }

  private detach(): void {
    for (const stop of this.unlisten.splice(0)) {
      stop();
    }

    this.ipc = null;
  }
}
