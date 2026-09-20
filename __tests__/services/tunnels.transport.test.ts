/**
 * Transport negotiation on the provision call, and the transport-aware revoke
 * (bead debugg_ai_mcp-xkoh.5.3, arc debugg_ai_mcp-xkoh.5).
 *
 * Requirements under test (xkoh.5.2 notes R1, R6, R9):
 *  - the provision request advertises transports ["debugg","ngrok"];
 *  - a response WITHOUT `transport` means ngrok, so an old backend keeps
 *    working against a new client;
 *  - a debugg response carries relayUrl + tunnelDomain through provision(),
 *    which rebuilds its result field by field and would otherwise drop them;
 *  - a malformed debugg response fails fast (non-retryable) instead of handing
 *    TunnelManager a token it cannot use;
 *  - the tunnelDomain a provision returns becomes rewritable, so a tunnel URL
 *    can never leak to a caller through sanitizeResponseUrls;
 *  - revoke routes by transport: ngrok keeps api/v1/ngrok/revoke/, debugg uses
 *    api/v1/tunnels/<tunnelId>/revoke/.
 *
 * These are RED on purpose: services/tunnels.ts neither sends `transports` nor
 * understands any of these fields yet.
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

const NGROK_RESPONSE = {
  tunnelId: 'tun-1',
  tunnelKey: 'key-1',
  keyId: 'kid-1',
  expiresAt: '2026-10-01T00:00:00Z',
};

const DEBUGG_RESPONSE = {
  ...NGROK_RESPONSE,
  transport: 'debugg',
  relayUrl: 'wss://api.debugg.ai/tunnel/v1/connect',
  tunnelDomain: 'tunnel.debugg.ai',
};

// ── Request side ─────────────────────────────────────────────────────────────

describe('provision(): advertises the transports this client can speak', () => {
  test('sends transports ["debugg","ngrok"] alongside purpose', async () => {
    mockPost.mockResolvedValue(NGROK_RESPONSE);

    await service.provision();

    expect(mockPost).toHaveBeenCalledWith('api/v1/tunnels/', {
      purpose: 'workflow',
      transports: ['debugg', 'ngrok'],
    });
  });

  test('a custom purpose still carries the transports list', async () => {
    mockPost.mockResolvedValue(NGROK_RESPONSE);

    await service.provision('live_session');

    expect(mockPost).toHaveBeenCalledWith('api/v1/tunnels/', {
      purpose: 'live_session',
      transports: ['debugg', 'ngrok'],
    });
  });
});

// ── Response side ────────────────────────────────────────────────────────────

describe('provision(): the backend picks the transport', () => {
  test('no `transport` in the response means ngrok — an old backend still works', async () => {
    mockPost.mockResolvedValue(NGROK_RESPONSE);

    const result = await service.provision();

    expect(result.transport).toBe('ngrok');
    expect(result.relayUrl).toBeUndefined();
    expect(result.tunnelDomain).toBeUndefined();
  });

  test('transport "debugg" carries relayUrl and tunnelDomain through', async () => {
    mockPost.mockResolvedValue(DEBUGG_RESPONSE);

    const result = await service.provision();

    expect(result).toMatchObject({
      tunnelId: 'tun-1',
      tunnelKey: 'key-1',
      keyId: 'kid-1',
      transport: 'debugg',
      relayUrl: 'wss://api.debugg.ai/tunnel/v1/connect',
      tunnelDomain: 'tunnel.debugg.ai',
    });
  });

  test('explicit transport "ngrok" is honoured and carries no relay fields', async () => {
    mockPost.mockResolvedValue({ ...NGROK_RESPONSE, transport: 'ngrok' });

    const result = await service.provision();

    expect(result.transport).toBe('ngrok');
  });
});

describe('provision(): a debugg response we cannot use fails fast', () => {
  // Every case here is non-retryable: retrying cannot turn a malformed
  // response into a usable one, and TunnelManager must never be handed a
  // debugg token with nowhere to send it.

  test('an unknown transport is refused — we only advertised two', async () => {
    mockPost.mockResolvedValue({ ...NGROK_RESPONSE, transport: 'quic-magic' });

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

describe('revoke(): routes by transport', () => {
  test('an ngrok tunnel still revokes through api/v1/ngrok/revoke/', async () => {
    mockPost.mockResolvedValue({});

    await service.revoke({ ...NGROK_RESPONSE, transport: 'ngrok' });

    expect(mockPost).toHaveBeenCalledWith('api/v1/ngrok/revoke/', { ngrokKeyId: 'kid-1' });
  });

  test('a debugg tunnel revokes through api/v1/tunnels/<tunnelId>/revoke/', async () => {
    mockPost.mockResolvedValue({});

    await service.revoke(DEBUGG_RESPONSE);

    // Only the path is pinned: whether the body is {} or omitted is an
    // implementation choice, but the endpoint is not.
    expect(mockPost.mock.calls[0][0]).toBe('api/v1/tunnels/tun-1/revoke/');
  });
});
