/**
 * Tests for TunnelManager concurrent port lock.
 * Uses a fresh TunnelManager instance with createTunnel patched so no real ngrok calls are made.
 */

import { jest } from '@jest/globals';
import TunnelManager from '../../services/ngrok/tunnelManager.js';
import type { TunnelInfo } from '../../services/ngrok/tunnelManager.js';

function makeFakeInfo(tunnelId: string, port: number, url: string): TunnelInfo {
  return {
    tunnelId,
    originalUrl: url,
    tunnelUrl: `https://${tunnelId}.ngrok.debugg.ai`,
    publicUrl: `https://${tunnelId}.ngrok.debugg.ai`,
    port,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    isOwned: true,
  };
}

describe('TunnelManager — concurrent port lock', () => {
  let manager: any;
  let createTunnelSpy: jest.Mock;

  beforeEach(() => {
    manager = new TunnelManager();

    // Patch createTunnel so no real ngrok calls are made.
    // The spy simulates network delay and stores the tunnel in activeTunnels (as the real impl does).
    createTunnelSpy = jest.fn(async (url: string, port: number, tunnelId: string) => {
      await new Promise(resolve => setTimeout(resolve, 40)); // simulate async work
      const info = makeFakeInfo(tunnelId, port, url);
      manager.activeTunnels.set(tunnelId, info);
      return info;
    });

    manager.createTunnel = createTunnelSpy;
  });

  afterEach(() => {
    manager.activeTunnels.clear();
    manager.pendingTunnels.clear();
  });

  test('concurrent calls for the same port only invoke createTunnel once', async () => {
    const [r1, r2] = await Promise.all([
      manager.processUrl('http://localhost:3000', 'auth-token', 'tunnel-a'),
      manager.processUrl('http://localhost:3000', 'auth-token', 'tunnel-b'),
    ]);

    expect(createTunnelSpy).toHaveBeenCalledTimes(1);
    // Both callers get the same tunnel
    expect(r1.tunnelId).toBe(r2.tunnelId);
    expect(r1.isLocalhost).toBe(true);
    expect(r2.isLocalhost).toBe(true);
  });

  test('pendingTunnels is cleared after creation completes', async () => {
    await manager.processUrl('http://localhost:3000', 'auth-token', 'tunnel-a');
    expect(manager.pendingTunnels.size).toBe(0);
  });

  test('sequential call reuses existing tunnel without creating a new one', async () => {
    await manager.processUrl('http://localhost:3000', 'auth-token', 'tunnel-a');
    await manager.processUrl('http://localhost:3000', 'auth-token', 'tunnel-b');

    expect(createTunnelSpy).toHaveBeenCalledTimes(1);
  });

  test('calls for different ports each create their own tunnel', async () => {
    await Promise.all([
      manager.processUrl('http://localhost:3000', 'auth-token', 'tunnel-a'),
      manager.processUrl('http://localhost:4000', 'auth-token', 'tunnel-b'),
    ]);

    expect(createTunnelSpy).toHaveBeenCalledTimes(2);
  });

  test('non-localhost URL bypasses tunnel creation entirely', async () => {
    const result = await manager.processUrl('https://example.com');
    expect(createTunnelSpy).not.toHaveBeenCalled();
    expect(result.isLocalhost).toBe(false);
    expect(result.url).toBe('https://example.com');
  });

  test('pendingTunnels is cleared even if createTunnel throws', async () => {
    createTunnelSpy.mockRejectedValueOnce(new Error('ngrok failure'));

    await expect(manager.processUrl('http://localhost:5000', 'auth-token', 'tunnel-x')).rejects.toThrow('ngrok failure');
    expect(manager.pendingTunnels.size).toBe(0);
  });
});
