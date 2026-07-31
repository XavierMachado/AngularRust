/**
 * In-flight calls, waiting for the reply that carries their id.
 *
 * WebTransport barely needs this: a request gets a stream, and the stream's EOF
 * proves the reply is not coming. A WebSocket gives no such signal — a reply
 * that never arrives is indistinguishable from one still being computed — so a
 * call needs both a deadline and something to reject it when the socket dies.
 * Both transports use it anyway, because one code path is the point.
 */

import type { Reply } from './protocol';

interface Waiting {
  resolve(reply: Reply): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class PendingCalls {
  private next = 1;
  private readonly waiting = new Map<number, Waiting>();

  /** Reserves an id and the promise its reply will settle. */
  open(timeoutMs: number): { id: number; reply: Promise<Reply> } {
    const id = this.next++;

    const reply = new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`The server did not answer within ${timeoutMs} ms`));
      }, timeoutMs);

      this.waiting.set(id, { resolve, reject, timer });
    });

    return { id, reply };
  }

  /** Settles the call with this id, if it is still waiting. */
  settle(id: number, reply: Reply): void {
    const call = this.waiting.get(id);
    if (!call) {
      // A reply to a call that already timed out. Nothing to do, and not worth
      // an error: it is the network being slow, which the caller already heard.
      return;
    }

    clearTimeout(call.timer);
    this.waiting.delete(id);
    call.resolve(reply);
  }

  /**
   * Rejects everything still waiting. A dropped link produces no per-call
   * error of its own, so without this a request in flight when the transport
   * died would hang until its deadline.
   */
  failAll(reason: string): void {
    for (const call of this.waiting.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(reason));
    }

    this.waiting.clear();
  }

  /** How many calls are outstanding. For tests and diagnostics. */
  get size(): number {
    return this.waiting.size;
  }
}
