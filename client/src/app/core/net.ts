/**
 * Every global the transport layer touches, in one injectable place.
 *
 * Before this file, `TransportService` reached for `globalThis.WebTransport`
 * and called `fetch` directly, which made it untestable without monkey-patching
 * the global scope — and it was, in fact, untested. Injecting them costs one
 * indirection and buys a service that can be driven by a fake.
 */

import { InjectionToken } from '@angular/core';

import { getWebTransport, type WtConstructor } from './webtransport.types';

/** The constructor shape, structurally typed the way `WtConstructor` is. */
export type WsConstructor = new (url: string) => WebSocket;

export interface Net {
  fetchJson<T>(url: string): Promise<T>;
  /** Null in a browser without WebTransport — Firefox and Safari, today. */
  readonly webTransport: WtConstructor | null;
  readonly webSocket: WsConstructor | null;
}

function browserNet(): Net {
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
  };
}

export const NET = new InjectionToken<Net>('NET', {
  providedIn: 'root',
  factory: browserNet,
});

/**
 * Where the server publishes its certificate fingerprint, its WebSocket URL and
 * the list of transports it offers. Plain HTTP: the same port number
 * WebTransport holds on UDP.
 */
export const DISCOVERY_URL = new InjectionToken<string>('DISCOVERY_URL', {
  providedIn: 'root',
  factory: () => 'http://127.0.0.1:4433/discovery',
});
