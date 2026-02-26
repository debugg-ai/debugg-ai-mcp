/**
 * TunnelsService tests.
 *
 * Covers:
 *  - provision() happy path with default and custom purpose
 *  - Missing tunnelId / tunnelKey in response
 *  - Transport error propagation
 */

import { jest } from '@jest/globals';
import type { TunnelsService } from '../../services/tunnels.js';
import { createTunnelsService } from '../../services/tunnels.js';

// Mock transport with a post() jest.fn()
const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
const mockTx = { post: mockPost } as any;

let service: TunnelsService;

beforeEach(() => {
  jest.clearAllMocks();
  service = createTunnelsService(mockTx);
});

describe('provision()', () => {
  const validResponse = {
    tunnelId: 'tun-123',
    tunnelKey: 'key-abc',
    keyId: 'kid-456',
    expiresAt: '2026-03-01T00:00:00Z',
  };

  test('happy path: POSTs to correct endpoint and returns provision data', async () => {
    mockPost.mockResolvedValue(validResponse);

    const result = await service.provision();

    expect(mockPost).toHaveBeenCalledWith('api/v1/tunnels/', { purpose: 'workflow' });
    expect(result).toEqual({
      tunnelId: 'tun-123',
      tunnelKey: 'key-abc',
      keyId: 'kid-456',
      expiresAt: '2026-03-01T00:00:00Z',
    });
  });

  test('custom purpose: sends provided purpose in body', async () => {
    mockPost.mockResolvedValue(validResponse);

    await service.provision('live_session');

    expect(mockPost).toHaveBeenCalledWith('api/v1/tunnels/', { purpose: 'live_session' });
  });

  test('no args: defaults to "workflow" purpose', async () => {
    mockPost.mockResolvedValue(validResponse);

    await service.provision();

    expect(mockPost).toHaveBeenCalledWith('api/v1/tunnels/', { purpose: 'workflow' });
  });

  test('response missing tunnelId: throws "Tunnel provisioning failed"', async () => {
    mockPost.mockResolvedValue({ tunnelKey: 'key-abc', keyId: 'kid-456', expiresAt: '2026-03-01T00:00:00Z' });

    await expect(service.provision()).rejects.toThrow('Tunnel provisioning failed');
  });

  test('response missing tunnelKey: throws "Tunnel provisioning failed"', async () => {
    mockPost.mockResolvedValue({ tunnelId: 'tun-123', keyId: 'kid-456', expiresAt: '2026-03-01T00:00:00Z' });

    await expect(service.provision()).rejects.toThrow('Tunnel provisioning failed');
  });

  test('response is null: throws "Tunnel provisioning failed"', async () => {
    mockPost.mockResolvedValue(null);

    await expect(service.provision()).rejects.toThrow('Tunnel provisioning failed');
  });

  test('transport post() throws: error propagates', async () => {
    mockPost.mockRejectedValue(new Error('Network error'));

    await expect(service.provision()).rejects.toThrow('Network error');
  });
});
