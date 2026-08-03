import { describe, expect, it } from 'vitest';

import { backoffMs, plan } from './negotiate';
import type { Discovery } from './protocol';

/**
 * The negotiation is pure on purpose: which transport to try is a policy
 * question, and a policy that needs a socket to test is one nobody tests.
 */
const discovery: Discovery = {
  url: 'https://localhost:4433/lab',
  websocketUrl: 'ws://127.0.0.1:4433/ws',
  transports: ['webtransport', 'websocket'],
  certHash: [],
  certHashHex: '',
  maxCertificateDays: 14,
};

const both = { webTransport: true, webSocket: true, ipc: false };
const desktop = { ...both, ipc: true };

describe('transport negotiation', () => {
  it('prefers WebTransport and keeps the WebSocket in reserve', () => {
    expect(plan('auto', discovery, both).attempt).toEqual(['webtransport', 'websocket']);
  });

  it('honours an explicit choice even when the other would work', () => {
    // The reason the manual override exists: on a network where QUIC is fine,
    // this is the only way to exercise the fallback.
    expect(plan('websocket', discovery, both).attempt).toEqual(['websocket']);
    expect(plan('webtransport', discovery, both).attempt).toEqual(['webtransport']);
  });

  it('drops WebTransport in a browser that has none, and says why', () => {
    const { attempt, excluded } = plan('auto', discovery, {
      webTransport: false,
      webSocket: true,
      ipc: false,
    });

    expect(attempt).toEqual(['websocket']);
    // Two exclusions: no WebTransport in this browser, no shell around it.
    expect(excluded).toHaveLength(2);
    expect(excluded[0]).toContain('WebTransport');
    expect(excluded[1]).toContain('desktop shell');
  });

  it('leaves nothing to try when the only choice is unavailable', () => {
    const { attempt, excluded } = plan('webtransport', discovery, {
      webTransport: false,
      webSocket: true,
      ipc: false,
    });

    expect(attempt).toEqual([]);
    expect(excluded).toHaveLength(1);
  });

  it('will not try a transport the server does not offer', () => {
    const wtOnly = { ...discovery, transports: ['webtransport'] as const };
    const { attempt, excluded } = plan(
      'auto',
      { ...wtOnly, transports: [...wtOnly.transports] },
      both,
    );

    expect(attempt).toEqual(['webtransport']);
    expect(excluded[0]).toContain('WebSocket');
  });

  it('treats a server that advertises nothing as offering everything', () => {
    // An older server predating the fallback. Refusing to connect to it would
    // be a regression dressed up as caution.
    const silent = { ...discovery, transports: [] };

    expect(plan('auto', silent, both).attempt).toEqual(['webtransport', 'websocket']);
  });

  it('keeps the in-process channel last, so the network stays the show', () => {
    expect(plan('auto', discovery, desktop).attempt).toEqual(['webtransport', 'websocket', 'ipc']);
  });

  it('refuses the in-process channel outside the desktop shell, and says why', () => {
    const { attempt, excluded } = plan('ipc', discovery, both);

    expect(attempt).toEqual([]);
    expect(excluded).toHaveLength(1);
    expect(excluded[0]).toContain('desktop shell');
  });

  it('offers the in-process channel regardless of what the server advertises', () => {
    // Discovery cannot know whether this page is inside the desktop shell, so
    // its transports list has no say over ipc — even an empty one.
    const silent = { ...discovery, transports: [] };

    expect(plan('ipc', silent, desktop).attempt).toEqual(['ipc']);
  });
});

describe('reconnect backoff', () => {
  it('grows from half a second and stops at eight', () => {
    expect(backoffMs(0)).toBe(500);
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    expect(backoffMs(4)).toBe(8_000);
    // Capped: a longer pause reads as having given up.
    expect(backoffMs(10)).toBe(8_000);
  });
});
