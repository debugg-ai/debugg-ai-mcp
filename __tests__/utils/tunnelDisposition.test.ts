/**
 * Tunnel disposition policy — what a failed health probe is allowed to do to a
 * tunnel we are already paying for.
 *
 * ngrok bills a MINIMUM OF ONE HOUR PER TUNNEL, so a teardown plus the
 * re-provision it forces costs TWO billed hours. Before this policy existed, all
 * four handlers evicted on ANY `ngrokErrorCode` and fell back to stopTunnel() on
 * everything else — i.e. every probe failure destroyed or de-registered a tunnel,
 * including the ~1-in-5 transient HTTP/2 GOAWAY from the ngrok edge (bead k6yq).
 *
 * These tests pin the two halves of the replacement:
 *   1. the allowlist itself, so a new ngrok code cannot silently default to
 *      teardown — adding one has to be a deliberate, evidenced act;
 *   2. the decision, so "the tunnel is alive and its upstream refused"
 *      (ERR_NGROK_8012) can never again be read as "the tunnel is dead".
 */

import { jest } from '@jest/globals';

const mockMarkTunnelDead = jest.fn<(...a: any[]) => Promise<void>>();
const mockStopTunnel = jest.fn<(...a: any[]) => Promise<void>>();

jest.unstable_mockModule('../../services/ngrok/tunnelManager.js', () => ({
  tunnelManager: { markTunnelDead: mockMarkTunnelDead, stopTunnel: mockStopTunnel },
}));

let ENDPOINT_GONE_NGROK_CODES: readonly string[];
let isEndpointGone: (code?: string) => boolean;
let disposeUnhealthyTunnel: typeof import('../../utils/tunnelDisposition.js').disposeUnhealthyTunnel;

beforeAll(async () => {
  ({ ENDPOINT_GONE_NGROK_CODES, isEndpointGone, disposeUnhealthyTunnel } =
    await import('../../utils/tunnelDisposition.js'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockMarkTunnelDead.mockResolvedValue(undefined);
  mockStopTunnel.mockResolvedValue(undefined);
});

const LOCALHOST = 'http://localhost:3011/dashboard';

// ── The allowlist ────────────────────────────────────────────────────────────

describe('ENDPOINT_GONE_NGROK_CODES', () => {
  // Deliberately an exact-membership assertion, not a `has()` spot check. A new
  // ngrok code must fail this test and force a decision, because the default for
  // an unrecognised code is "keep the tunnel" and getting that backwards costs
  // two billed hours per occurrence.
  test('contains exactly the codes that PROVE the endpoint is gone', () => {
    expect([...ENDPOINT_GONE_NGROK_CODES].sort()).toEqual(['ERR_NGROK_3200']);
  });

  test('ERR_NGROK_8012 is NOT in the allowlist — that code means the tunnel is ALIVE', () => {
    // 8012 is the agent failing to dial the upstream. The tunnel is the thing
    // that served us the error page; evicting on it orphans a live, billing
    // tunnel and buys a duplicate to work around a dev server that is down.
    expect(ENDPOINT_GONE_NGROK_CODES).not.toContain('ERR_NGROK_8012');
    expect(isEndpointGone('ERR_NGROK_8012')).toBe(false);
  });

  // Object.freeze does NOT make a Set immutable — its entries live in internal
  // slots, so `.add()` on a "frozen" Set succeeds silently and an assertion on
  // Object.isFrozen(set) passes while guaranteeing nothing. The allowlist is a
  // frozen ARRAY for that reason, which is a real runtime guarantee. Prove it by
  // attempting the mutation rather than by asking isFrozen.
  test('the policy cannot be mutated at runtime', () => {
    expect(Object.isFrozen(ENDPOINT_GONE_NGROK_CODES)).toBe(true);
    expect(() => {
      (ENDPOINT_GONE_NGROK_CODES as string[]).push('ERR_NGROK_8012');
    }).toThrow(TypeError);
    expect(isEndpointGone('ERR_NGROK_8012')).toBe(false);
  });
});

describe('isEndpointGone', () => {
  test.each([
    ['ERR_NGROK_3200', true],
    ['ERR_NGROK_8012', false],
    ['ERR_NGROK_6024', false],   // unknown code — absence of proof, not proof of death
    ['', false],
    [undefined, false],
  ] as const)('%s → %s', (code, expected) => {
    expect(isEndpointGone(code as string | undefined)).toBe(expected);
  });
});

// ── The decision ─────────────────────────────────────────────────────────────

describe('disposeUnhealthyTunnel', () => {
  test('ERR_NGROK_3200 → evicts via markTunnelDead with the parsed port', () => {
    disposeUnhealthyTunnel({
      health: { healthy: false, code: 'NGROK_ERROR', ngrokErrorCode: 'ERR_NGROK_3200', elapsedMs: 40 },
      tunnelId: 't-dead',
      originalUrl: LOCALHOST,
    });

    // markTunnelDead, not stopTunnel: for a BORROWED tunnel only markTunnelDead
    // evicts the shared registry entry, which is what stops every other session
    // re-borrowing the corpse (bead k34o).
    expect(mockMarkTunnelDead).toHaveBeenCalledWith(3011, 't-dead');
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });

  test('ERR_NGROK_8012 → touches nothing (the tunnel is alive; the dev server is not)', () => {
    disposeUnhealthyTunnel({
      health: { healthy: false, status: 502, code: 'NGROK_ERROR', ngrokErrorCode: 'ERR_NGROK_8012', elapsedMs: 40 },
      tunnelId: 't-live',
      originalUrl: LOCALHOST,
    });

    expect(mockMarkTunnelDead).not.toHaveBeenCalled();
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });

  // Per bead kmzb (confirmed live 2026-07-27) these are the ONLY shapes a real
  // probe failure can currently take: undici negotiates HTTP/2 and the ngrok edge
  // answers with a GOAWAY, so no interstitial and no code ever reach us — even
  // for a hostname ngrok genuinely no longer routes.
  test.each([
    ['NETWORK_ERROR', 'fetch failed (UND_ERR_SOCKET: HTTP/2 "GOAWAY" frame received with code 0)'],
    ['TIMEOUT', 'tunnel health probe timed out after 5000ms'],
    ['BAD_GATEWAY', 'tunnel returned 502 without an ngrok error marker'],
    ['UNKNOWN', 'something else entirely'],
  ])('%s without a code → touches nothing', (code, detail) => {
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
      health: { healthy: false, code: 'NGROK_ERROR', ngrokErrorCode: 'ERR_NGROK_3200', elapsedMs: 40 },
      tunnelId: undefined,
      originalUrl: LOCALHOST,
    });

    expect(mockMarkTunnelDead).not.toHaveBeenCalled();
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });

  test('proven-dead code but an unparseable port → keeps the tunnel rather than guessing', () => {
    // markTunnelDead is keyed by port. Without one, the old code fell back to a
    // blind stopTunnel — the exact teardown this policy exists to prevent.
    disposeUnhealthyTunnel({
      health: { healthy: false, code: 'NGROK_ERROR', ngrokErrorCode: 'ERR_NGROK_3200', elapsedMs: 40 },
      tunnelId: 't-dead',
      originalUrl: 'https://staging.example.com/app',
    });

    expect(mockMarkTunnelDead).not.toHaveBeenCalled();
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });

  test('a failing eviction never escapes — cleanup must not break the error response', async () => {
    mockMarkTunnelDead.mockRejectedValueOnce(new Error('registry write failed'));

    expect(() =>
      disposeUnhealthyTunnel({
        health: { healthy: false, code: 'NGROK_ERROR', ngrokErrorCode: 'ERR_NGROK_3200', elapsedMs: 40 },
        tunnelId: 't-dead',
        originalUrl: LOCALHOST,
      }),
    ).not.toThrow();

    // Flush the fire-and-forget rejection; an unhandled one would fail the suite.
    await Promise.resolve();
    expect(mockMarkTunnelDead).toHaveBeenCalled();
  });
});
