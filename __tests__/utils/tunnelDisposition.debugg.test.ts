/**
 * Disposition policy for debugg tunnel markers (bead debugg_ai_mcp-xkoh.5.3).
 *
 * Requirement (xkoh.5.2 notes R8): the DEBUGG_TUNNEL_* markers replace the
 * ERR_NGROK_* ones, and they split the same way:
 *   DEBUGG_TUNNEL_OFFLINE / DEBUGG_TUNNEL_UNKNOWN  -> the endpoint is gone,
 *     evicting costs nothing and the next call re-provisions;
 *   DEBUGG_TUNNEL_UPSTREAM_REFUSED                 -> the TUNNEL served us
 *     that page, so it is alive; the user's dev server is the problem. This is
 *     the exact ERR_NGROK_8012 lesson, and getting it backwards throws away a
 *     working tunnel mid-session.
 *
 * The existing exact-membership test in tunnelDisposition.test.ts pins the
 * allowlist to ['ERR_NGROK_3200'] deliberately, so that adding a code is a
 * conscious act. It is updated in 4.1, together with this behaviour.
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

describe('the allowlist covers both transports', () => {
  test('contains exactly the codes that prove the endpoint is gone, for ngrok AND debugg', () => {
    expect([...ENDPOINT_GONE_NGROK_CODES].sort()).toEqual([
      'DEBUGG_TUNNEL_OFFLINE',
      'DEBUGG_TUNNEL_UNKNOWN',
      'ERR_NGROK_3200',
    ]);
  });

  test('DEBUGG_TUNNEL_UPSTREAM_REFUSED is NOT in it — that marker means the tunnel is alive', () => {
    expect(ENDPOINT_GONE_NGROK_CODES).not.toContain('DEBUGG_TUNNEL_UPSTREAM_REFUSED');
    expect(isEndpointGone('DEBUGG_TUNNEL_UPSTREAM_REFUSED')).toBe(false);
  });

  test('isEndpointGone recognises the debugg gone-codes', () => {
    expect(isEndpointGone('DEBUGG_TUNNEL_OFFLINE')).toBe(true);
    expect(isEndpointGone('DEBUGG_TUNNEL_UNKNOWN')).toBe(true);
  });
});

describe('disposeUnhealthyTunnel acts on debugg markers the same way', () => {
  test('DEBUGG_TUNNEL_OFFLINE evicts the tunnel', () => {
    disposeUnhealthyTunnel({
      health: { healthy: false, code: 'NGROK_ERROR', ngrokErrorCode: 'DEBUGG_TUNNEL_OFFLINE', elapsedMs: 12 },
      tunnelId: 'tid-1',
      originalUrl: LOCALHOST,
    });

    expect(mockMarkTunnelDead).toHaveBeenCalledWith('tid-1');
  });

  test('DEBUGG_TUNNEL_UNKNOWN evicts the tunnel — the id is unknown or revoked', () => {
    disposeUnhealthyTunnel({
      health: { healthy: false, code: 'NGROK_ERROR', ngrokErrorCode: 'DEBUGG_TUNNEL_UNKNOWN', elapsedMs: 12 },
      tunnelId: 'tid-2',
      originalUrl: LOCALHOST,
    });

    expect(mockMarkTunnelDead).toHaveBeenCalledWith('tid-2');
  });

  test('DEBUGG_TUNNEL_UPSTREAM_REFUSED keeps the tunnel — the dev server is the problem', () => {
    disposeUnhealthyTunnel({
      health: {
        healthy: false,
        status: 502,
        code: 'NGROK_ERROR',
        ngrokErrorCode: 'DEBUGG_TUNNEL_UPSTREAM_REFUSED',
        elapsedMs: 12,
      },
      tunnelId: 'tid-3',
      originalUrl: LOCALHOST,
    });

    expect(mockMarkTunnelDead).not.toHaveBeenCalled();
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });
});
