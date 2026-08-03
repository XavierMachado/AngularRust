/**
 * Minimal typings for the browser WebTransport API.
 *
 * These are deliberately named `Wt*` rather than augmenting the global scope.
 * Whether `lib.dom.d.ts` ships WebTransport depends on the TypeScript version,
 * and a global `declare` that collides with a built-in one is a compile error
 * that only appears after a routine TypeScript bump. Structural types plus one
 * cast at the boundary work on every version.
 */

export interface WtCloseInfo {
  closeCode?: number;
  reason?: string;
}

export interface WtBidirectionalStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

export interface WtDatagramDuplex {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly maxDatagramSize: number;
}

export interface WtSession {
  readonly ready: Promise<void>;
  readonly closed: Promise<WtCloseInfo | undefined>;
  readonly datagrams: WtDatagramDuplex;
  readonly incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>;
  readonly incomingBidirectionalStreams: ReadableStream<WtBidirectionalStream>;
  createBidirectionalStream(): Promise<WtBidirectionalStream>;
  createUnidirectionalStream(): Promise<WritableStream<Uint8Array>>;
  close(info?: WtCloseInfo): void;
}

export interface WtOptions {
  /**
   * Trusts a specific certificate instead of the CA chain. Chrome accepts this
   * only for HTTP/3, an ECDSA P-256 key, and a validity window of 14 days or
   * less.
   */
  serverCertificateHashes?: { algorithm: 'sha-256'; value: BufferSource }[];
  allowPooling?: boolean;
  requireUnreliable?: boolean;
  congestionControl?: 'default' | 'throughput' | 'low-latency';
}

export type WtConstructor = new (url: string, options?: WtOptions) => WtSession;

/** Returns the constructor, or null in a browser that doesn't have it. */
export function getWebTransport(): WtConstructor | null {
  const candidate = (globalThis as Record<string, unknown>)['WebTransport'];
  return typeof candidate === 'function' ? (candidate as WtConstructor) : null;
}
