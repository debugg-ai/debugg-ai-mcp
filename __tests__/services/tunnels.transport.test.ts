/**
 * Transport negotiation on the provision call, and revoke
 * (bead debugg_ai_mcp-xkoh.5.3 / .6.4, arc debugg_ai_mcp-xkoh.5).
 *
 * Requirements under test (xkoh.5.2 notes R1, R6, R9):
 *  - the provision request STILL advertises `transports`, now just ["debugg"].
 *    Sending nothing is not equivalent: the backend treats an offer-less
 *    request as a pre-negotiation client and hands it ngrok, which this client
 *    can no longer speak;
 *  - a response this client cannot use — `transport: "ngrok"`, an unknown
 *    transport, or no relayUrl/tunnelDomain at all — fails fast and
 *    non-retryably, rather than handing TunnelManager a token with nowhere to
 *    send it;
 *  - a usable response carries relayUrl + tunnelDomain through provision(),
 *    which rebuilds its result field by field and would otherwise drop them;
 *  - the tunnelDomain a provision returns becomes rewritable, so a tunnel URL
 *    can never leak to a caller through sanitizeResponseUrls;
 *  - revoke goes to api/v1/tunnels/<tunnelId>/revoke/.
 */

import { jest } from '@jest/globals';
import { createTunnelsService } from '../../services/tunnels.js';
import { replaceTunnelUrls } from '../../utils/urlParser.js';

const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
const mockTx = { post: mockPost } as any;

let service: any;

beforeEach(() => {
  jest.clearAllMocks();
  service = createTunnelsService(mockTx);
});

/** What a backend that predates the debugg tunnel server answers with. */
const LEGACY_RESPONSE = {
  tunnelId: 'tun-1',
  tunnelKey: 'key-1',
  keyId: 'kid-1',
  expiresAt: '2026-10-01T00:00:00Z',
};

const DEBUGG_RESPONSE = {
  ...LEGACY_RESPONSE,
  transport: 'debugg',
  relayUrl: 'wss://api.debugg.ai/tunnel/v1/connect',
  tunnelDomain: 'tunnel.debugg.ai',
};

// ── Request side ─────────────────────────────────────────────────────────────

describe('provision(): advertises the transports this client can speak', () => {
  test('sends transports ["debugg"] alongside purpose — NEVER an empty offer', async () => {
    mockPost.mockResolvedValue(DEBUGG_RESPONSE);

    await service.provision();

    expect(mockPost).toHaveBeenCalledWith('api/v1/tunnels/', {
      purpose: 'workflow',
      transports: ['debugg'],
    });
  });

  test('a custom purpose still carries the transports list', async () => {
    mockPost.mockResolvedValue(DEBUGG_RESPONSE);

    await service.provision('live_session');

    expect(mockPost).toHaveBeenCalledWith('api/v1/tunnels/', {
      purpose: 'live_session',
      transports: ['debugg'],
    });
  });

  test('the offer is never empty or absent — that is what gets us handed ngrok', async () => {
    mockPost.mockResolvedValue(DEBUGG_RESPONSE);

    await service.provision();

    const body = mockPost.mock.calls[0][1] as any;
    expect(Array.isArray(body.transports)).toBe(true);
    expect(body.transports.length).toBeGreaterThan(0);
  });
});

// ── Response side ────────────────────────────────────────────────────────────

describe('provision(): the backend picks the transport', () => {
  test('transport "debugg" carries relayUrl and tunnelDomain through', async () => {
    mockPost.mockResolvedValue(DEBUGG_RESPONSE);

    const result = await service.provision();

    expect(result).toMatchObject({
      tunnelId: 'tun-1',
      tunnelKey: 'key-1',
      keyId: 'kid-1',
      relayUrl: 'wss://api.debugg.ai/tunnel/v1/connect',
      tunnelDomain: 'tunnel.debugg.ai',
    });
  });

  test('a response that omits `transport` but carries the debugg fields is accepted', async () => {
    // Self-describing beats guessing a default. The fields are what
    // TunnelManager actually needs; `transport` is only the label.
    const { transport, ...noLabel } = DEBUGG_RESPONSE;
    mockPost.mockResolvedValue(noLabel);

    const result = await service.provision();

    expect(result.relayUrl).toBe('wss://api.debugg.ai/tunnel/v1/connect');
    expect(result.tunnelDomain).toBe('tunnel.debugg.ai');
  });
});

describe('provision(): a response we cannot use fails fast', () => {
  // Every case here is non-retryable: retrying cannot turn a response this
  // client cannot use into one it can, and TunnelManager must never be handed
  // a token with nowhere to send it.

  test('transport "ngrok" is refused, and the error names the version mismatch', async () => {
    mockPost.mockResolvedValue({ ...LEGACY_RESPONSE, transport: 'ngrok' });

    await expect(service.provision()).rejects.toMatchObject({
      name: 'TunnelProvisionError',
      retryable: false,
      message: expect.stringContaining('ngrok'),
    });
    // The message has to tell the user what to actually do about it.
    await expect(service.provision()).rejects.toThrow(/4\.4\.1/);
  });

  test('a pre-negotiation backend (no transport, no relay fields) is refused', async () => {
    mockPost.mockResolvedValue(LEGACY_RESPONSE);

    await expect(service.provision()).rejects.toMatchObject({
      name: 'TunnelProvisionError',
      retryable: false,
    });
  });

  test('an unknown transport is refused — we only advertised one', async () => {
    mockPost.mockResolvedValue({ ...DEBUGG_RESPONSE, transport: 'quic-magic' });

    await expect(service.provision()).rejects.toMatchObject({
      name: 'TunnelProvisionError',
      retryable: false,
    });
  });

  test('transport "debugg" without relayUrl is refused', async () => {
    const { relayUrl, ...noRelay } = DEBUGG_RESPONSE;
    mockPost.mockResolvedValue(noRelay);

    await expect(service.provision()).rejects.toMatchObject({
      name: 'TunnelProvisionError',
      retryable: false,
    });
  });

  test('transport "debugg" without tunnelDomain is refused', async () => {
    const { tunnelDomain, ...noDomain } = DEBUGG_RESPONSE;
    mockPost.mockResolvedValue(noDomain);

    await expect(service.provision()).rejects.toMatchObject({
      name: 'TunnelProvisionError',
      retryable: false,
    });
  });

  test('a plaintext relayUrl is refused BEFORE the tunnel key can be sent over it', async () => {
    mockPost.mockResolvedValue({ ...DEBUGG_RESPONSE, relayUrl: 'ws://api.debugg.ai/tunnel/v1/connect' });

    await expect(service.provision()).rejects.toMatchObject({
      name: 'TunnelProvisionError',
      retryable: false,
    });
  });

  test('a loopback ws:// relayUrl IS allowed — that is the local backend / test server', async () => {
    mockPost.mockResolvedValue({ ...DEBUGG_RESPONSE, relayUrl: 'ws://127.0.0.1:8080/tunnel/v1/connect' });

    const result = await service.provision();

    expect(result.relayUrl).toBe('ws://127.0.0.1:8080/tunnel/v1/connect');
  });

  test('a too-broad tunnelDomain is refused — it would rewrite real debugg.ai links into localhost', async () => {
    mockPost.mockResolvedValue({ ...DEBUGG_RESPONSE, tunnelDomain: 'debugg.ai' });

    await expect(service.provision()).rejects.toMatchObject({
      name: 'TunnelProvisionError',
      retryable: false,
    });
  });
});

// ── Known tunnel domains (R6) ────────────────────────────────────────────────

describe('a provisioned tunnelDomain becomes rewritable, so no tunnel URL leaks', () => {
  test('the built-in debugg domain is rewritten with no provision at all', () => {
    expect(
      replaceTunnelUrls('open https://tun-1.tunnel.debugg.ai/dash', 'http://localhost:3000'),
    ).toBe('open http://localhost:3000/dash');
  });

  test('a domain the backend moved to is registered on provision and rewritten afterwards', async () => {
    mockPost.mockResolvedValue({ ...DEBUGG_RESPONSE, tunnelDomain: 'tunnel-staging.debugg.ai' });

    await service.provision();

    expect(
      replaceTunnelUrls('open https://tun-1.tunnel-staging.debugg.ai/dash', 'http://localhost:3000'),
    ).toBe('open http://localhost:3000/dash');
  });
});

// ── Revoke (R9) ──────────────────────────────────────────────────────────────

describe('revoke()', () => {
  test('revokes through api/v1/tunnels/<tunnelId>/revoke/', async () => {
    mockPost.mockResolvedValue({});

    await service.revoke(DEBUGG_RESPONSE);

    // Only the path is pinned: whether the body is {} or omitted is an
    // implementation choice, but the endpoint is not.
    expect(mockPost.mock.calls[0][0]).toBe('api/v1/tunnels/tun-1/revoke/');
  });
});
