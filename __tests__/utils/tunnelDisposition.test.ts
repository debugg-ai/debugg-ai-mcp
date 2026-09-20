/**
 * Tunnel disposition policy — what a failed health probe is allowed to do to a
 * tunnel we already have.
 *
 * Before this policy existed, all four handlers evicted on ANY error code and
 * fell back to stopTunnel() on everything else — i.e. every probe failure
 * destroyed or de-registered a tunnel, including the ~1-in-5 transient
 * connection flake (bead k6yq).
 *
 * These tests pin the two halves of the replacement:
 *   1. the allowlist itself, so a new marker cannot silently default to
 *      teardown — adding one has to be a deliberate, evidenced act;
 *   2. the decision, so "the tunnel is alive and its upstream refused"
 *      (DEBUGG_TUNNEL_UPSTREAM_REFUSED) can never be read as "the tunnel is
 *      dead".
 *
 * Merged from the former tunnelDisposition.debugg.test.ts, which existed only
 * to cover the DEBUGG_TUNNEL_* markers alongside the ngrok ones. With ngrok
 * deleted there is no "alongside" left — one policy, one file.
 */

import { jest } from '@jest/globals';

const mockMarkTunnelDead = jest.fn<(...a: any[]) => Promise<void>>();
const mockStopTunnel = jest.fn<(...a: any[]) => Promise<void>>();

jest.unstable_mockModule('../../services/tunnel/tunnelManager.js', () => ({
  tunnelManager: { markTunnelDead: mockMarkTunnelDead, stopTunnel: mockStopTunnel },
}));

let ENDPOINT_GONE_TUNNEL_CODES: readonly string[];
let isEndpointGone: (code?: string) => boolean;
let disposeUnhealthyTunnel: typeof import('../../utils/tunnelDisposition.js').disposeUnhealthyTunnel;

beforeAll(async () => {
  ({ ENDPOINT_GONE_TUNNEL_CODES, isEndpointGone, disposeUnhealthyTunnel } =
    await import('../../utils/tunnelDisposition.js'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockMarkTunnelDead.mockResolvedValue(undefined);
  mockStopTunnel.mockResolvedValue(undefined);
});

const LOCALHOST = 'http://localhost:3011/dashboard';

// ── The allowlist ────────────────────────────────────────────────────────────

describe('ENDPOINT_GONE_TUNNEL_CODES', () => {
  // Deliberately an exact-membership assertion, not a `has()` spot check. A new
  // marker must fail this test and force a decision, because the default for an
  // unrecognised one is "keep the tunnel" and getting that backwards throws
  // away a working tunnel mid-session.
  test('contains exactly the markers that PROVE the endpoint is gone', () => {
    expect([...ENDPOINT_GONE_TUNNEL_CODES].sort()).toEqual([
      'DEBUGG_TUNNEL_OFFLINE',
      'DEBUGG_TUNNEL_UNKNOWN',
    ]);
  });

  test('DEBUGG_TUNNEL_UPSTREAM_REFUSED is NOT in it — that marker means the tunnel is ALIVE', () => {
    // UPSTREAM_REFUSED is the client failing to dial the local app. The tunnel
    // is the thing that served us the error page; evicting on it throws away a
    // working tunnel to work around a dev server that is down.
    expect(ENDPOINT_GONE_TUNNEL_CODES).not.toContain('DEBUGG_TUNNEL_UPSTREAM_REFUSED');
    expect(isEndpointGone('DEBUGG_TUNNEL_UPSTREAM_REFUSED')).toBe(false);
  });

  // Object.freeze does NOT make a Set immutable — its entries live in internal
  // slots, so `.add()` on a "frozen" Set succeeds silently and an assertion on
  // Object.isFrozen(set) passes while guaranteeing nothing. The allowlist is a
  // frozen ARRAY for that reason, which is a real runtime guarantee. Prove it by
  // attempting the mutation rather than by asking isFrozen.
  test('the policy cannot be mutated at runtime', () => {
    expect(Object.isFrozen(ENDPOINT_GONE_TUNNEL_CODES)).toBe(true);
    expect(() => {
      (ENDPOINT_GONE_TUNNEL_CODES as string[]).push('DEBUGG_TUNNEL_UPSTREAM_REFUSED');
    }).toThrow(TypeError);
    expect(isEndpointGone('DEBUGG_TUNNEL_UPSTREAM_REFUSED')).toBe(false);
  });

  // A retired ngrok code must not be honoured as proof of anything. No tunnel
  // this client can create serves one, so a string that looks like one reached
  // us from somewhere else — a user's own page, a log line — and acting on it
  // would tear down a healthy tunnel on someone else's text.
  test('a retired ngrok code is not proof of death', () => {
    expect(isEndpointGone('ERR_NGROK_3200')).toBe(false);
    expect(isEndpointGone('ERR_NGROK_8012')).toBe(false);
  });
});

describe('isEndpointGone', () => {
  test.each([
    ['DEBUGG_TUNNEL_OFFLINE', true],
    ['DEBUGG_TUNNEL_UNKNOWN', true],
    ['DEBUGG_TUNNEL_UPSTREAM_REFUSED', false],
    ['DEBUGG_TUNNEL_SOMETHING_NEW', false], // unknown marker — absence of proof, not proof of death
    ['', false],
    [undefined, false],
  ] as const)('%s → %s', (code, expected) => {
    expect(isEndpointGone(code as string | undefined)).toBe(expected);
  });
});

// ── The decision ─────────────────────────────────────────────────────────────

describe('disposeUnhealthyTunnel', () => {
  test('DEBUGG_TUNNEL_OFFLINE → evicts via markTunnelDead(tunnelId) — no port needed anymore', () => {
    disposeUnhealthyTunnel({
      health: { healthy: false, code: 'TUNNEL_ERROR', tunnelErrorCode: 'DEBUGG_TUNNEL_OFFLINE', elapsedMs: 40 },
      tunnelId: 't-dead',
      originalUrl: LOCALHOST,
    });

    // §2.3: markTunnelDead dropped its `port` parameter — eviction is no
    // longer port-scoped now that every tunnel is created (never borrowed)
    // by this process (§4).
    expect(mockMarkTunnelDead).toHaveBeenCalledWith('t-dead');
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });

  test('DEBUGG_TUNNEL_UNKNOWN → evicts the tunnel — the id is unknown or revoked', () => {
    disposeUnhealthyTunnel({
      health: { healthy: false, code: 'TUNNEL_ERROR', tunnelErrorCode: 'DEBUGG_TUNNEL_UNKNOWN', elapsedMs: 12 },
      tunnelId: 't-gone',
      originalUrl: LOCALHOST,
    });

    expect(mockMarkTunnelDead).toHaveBeenCalledWith('t-gone');
  });

  test('DEBUGG_TUNNEL_UPSTREAM_REFUSED → touches nothing (the tunnel is alive; the dev server is not)', () => {
    disposeUnhealthyTunnel({
      health: {
        healthy: false,
        status: 502,
        code: 'TUNNEL_ERROR',
        tunnelErrorCode: 'DEBUGG_TUNNEL_UPSTREAM_REFUSED',
        elapsedMs: 40,
      },
      tunnelId: 't-live',
      originalUrl: LOCALHOST,
    });

    expect(mockMarkTunnelDead).not.toHaveBeenCalled();
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });

  test.each([
    ['NETWORK_ERROR', 'tunnel control channel reported RESET'],
    ['TIMEOUT', 'tunnel health probe timed out after 5000ms'],
    ['BAD_GATEWAY', 'tunnel returned 502 without an error marker'],
    ['UNKNOWN', 'something else entirely'],
  ])('%s without a marker → touches nothing', (code, detail) => {
    disposeUnhealthyTunnel({
      health: { healthy: false, code: code as any, detail, elapsedMs: 800 },
      tunnelId: 't-live',
      originalUrl: LOCALHOST,
    });

    expect(mockMarkTunnelDead).not.toHaveBeenCalled();
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });

  test('no tunnelId → nothing to dispose of', () => {
    disposeUnhealthyTunnel({
      health: { healthy: false, code: 'TUNNEL_ERROR', tunnelErrorCode: 'DEBUGG_TUNNEL_OFFLINE', elapsedMs: 40 },
      tunnelId: undefined,
      originalUrl: LOCALHOST,
    });

    expect(mockMarkTunnelDead).not.toHaveBeenCalled();
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });

  test('proven-dead marker with a non-localhost originalUrl → still evicts (originalUrl is no longer load-bearing)', () => {
    // markTunnelDead(tunnelId) no longer needs a port parsed out of
    // originalUrl (§2.3), so this decision no longer depends on originalUrl
    // being a parseable localhost URL at all.
    disposeUnhealthyTunnel({
      health: { healthy: false, code: 'TUNNEL_ERROR', tunnelErrorCode: 'DEBUGG_TUNNEL_OFFLINE', elapsedMs: 40 },
      tunnelId: 't-dead',
      originalUrl: 'https://staging.example.com/app',
    });

    expect(mockMarkTunnelDead).toHaveBeenCalledWith('t-dead');
  });

  test('a failing eviction never escapes — cleanup must not break the error response', async () => {
    mockMarkTunnelDead.mockRejectedValueOnce(new Error('registry write failed'));

    expect(() =>
      disposeUnhealthyTunnel({
        health: { healthy: false, code: 'TUNNEL_ERROR', tunnelErrorCode: 'DEBUGG_TUNNEL_OFFLINE', elapsedMs: 40 },
        tunnelId: 't-dead',
        originalUrl: LOCALHOST,
      }),
    ).not.toThrow();

    // Flush the fire-and-forget rejection; an unhandled one would fail the suite.
    await Promise.resolve();
    expect(mockMarkTunnelDead).toHaveBeenCalled();
  });
});
