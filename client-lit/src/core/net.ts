/**
 * Every global the transport layer touches, in one replaceable place.
 *
 * The store reaches neither for `globalThis.WebTransport` nor for `fetch`
 * directly; it takes a `Net` in its constructor, which keeps the links and the
 * store drivable by a fake under plain Node. The Angular client does the same
 * with an `InjectionToken` — here a constructor argument is the whole story.
 */

import { getTauriIpc, type TauriIpc } from './tauri-ipc';
import { getWebTransport, type WtConstructor } from './webtransport.types';

/** The constructor shape, structurally typed the way `WtConstructor` is. */
export type WsConstructor = new (url: string) => WebSocket;

export interface Net {
  fetchJson<T>(url: string): Promise<T>;
  /** Null in a browser without WebTransport — Firefox and Safari, today. */
  readonly webTransport: WtConstructor | null;
  readonly webSocket: WsConstructor | null;
  /** Null outside the desktop shell, which is everywhere but the desktop shell. */
  readonly tauriIpc: TauriIpc | null;
}

export function browserNet(): Net {
  const candidate = (globalThis as Record<string, unknown>)['WebSocket'];

  return {
    async fetchJson<T>(url: string): Promise<T> {
      const response = await fetch(url, { cache: 'no-store' });

      if (!response.ok) {
        throw new Error(`${url} returned ${response.status}`);
      }

      return (await response.json()) as T;
    },
    webTransport: getWebTransport(),
    webSocket: typeof candidate === 'function' ? (candidate as WsConstructor) : null,
    tauriIpc: getTauriIpc(),
  };
}

/**
 * Where the server publishes its certificate fingerprint, its WebSocket URL and
 * the list of transports it offers. Plain HTTP: the same port number
 * WebTransport holds on UDP.
 */
export const DISCOVERY_URL = 'http://127.0.0.1:4433/discovery';
