/**
 * Choosing a transport.
 *
 * Pure functions over what the browser can do, what the server offers and what
 * the user asked for. No sockets, no signals, no Angular — which is what lets
 * the policy be tested without any of those.
 */

import type { Discovery, TransportKind } from './protocol';

/**
 * `auto` tries WebTransport and falls back. The explicit choices exist because
 * "the network blocks QUIC" is not the only reason to want the other one: on a
 * network where both work, forcing the fallback is the only way to see it.
 */
export type Preference = 'auto' | 'webtransport' | 'websocket';

export interface Capabilities {
  webTransport: boolean;
  webSocket: boolean;
}

export interface Plan {
  /** What to try, in order. Empty means nothing can work; see `excluded`. */
  attempt: TransportKind[];
  /** Why anything the user might have expected is not being tried. */
  excluded: string[];
}

/** In preference order when nothing narrows it. */
const BEST_FIRST: TransportKind[] = ['webtransport', 'websocket'];

export function plan(
  preference: Preference,
  discovery: Discovery,
  capabilities: Capabilities,
): Plan {
  const wanted = preference === 'auto' ? BEST_FIRST : [preference];
  const attempt: TransportKind[] = [];
  const excluded: string[] = [];

  for (const transport of wanted) {
    const reason = unavailable(transport, discovery, capabilities);

    if (reason) {
      excluded.push(reason);
    } else {
      attempt.push(transport);
    }
  }

  return { attempt, excluded };
}

/** Why this transport cannot be tried, or null when it can. */
function unavailable(
  transport: TransportKind,
  discovery: Discovery,
  capabilities: Capabilities,
): string | null {
  // An older server may not advertise the list at all; treat a missing one as
  // "offers everything" rather than refusing to connect to it.
  const offered = discovery.transports?.length ? discovery.transports : BEST_FIRST;

  if (!offered.includes(transport)) {
    return `${label(transport)} is not offered by this server.`;
  }

  if (transport === 'webtransport' && !capabilities.webTransport) {
    return 'This browser has no WebTransport. Chrome or Edge 97 and up have it; everything else uses the WebSocket.';
  }

  if (transport === 'websocket' && !capabilities.webSocket) {
    return 'This browser has no WebSocket, which is a surprising place to be.';
  }

  return null;
}

export function label(transport: TransportKind): string {
  return transport === 'webtransport' ? 'WebTransport' : 'WebSocket';
}

/** How the masthead describes what is carrying the session. */
export function describeTransport(transport: TransportKind): string {
  return transport === 'webtransport'
    ? 'WebTransport · HTTP/3 over QUIC'
    : 'WebSocket · TCP · fallback';
}

/**
 * How long to wait before the next attempt, in milliseconds.
 *
 * Exponential from half a second, capped at eight — long enough to outlast a
 * server restart, short enough that a person watching does not conclude it has
 * given up.
 */
export function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8_000);
}
