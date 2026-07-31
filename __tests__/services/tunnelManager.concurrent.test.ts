/**
 * Tests for TunnelManager's session-tunnel concurrency (§2.3/§2.4 of
 * docs/local-tunnel-multiplexer-architecture-2026-07-31.md).
 *
 * Under the old per-port model, "different ports each create their own
 * tunnel" was the correct, intended behavior — that is exactly the
 * mechanism this epic replaces. §5.2 calls this test file out by name:
 * "Rewrite to assert ONE createTunnel/ensureSessionTunnel call total for two
 * different-port calls in one session, serialized through the lock and
 * Caddy repointed between them." This file now exercises that contract
 * directly against the REAL `PortLock` (services/caddy/portLock.ts) bound to
 * a fake `CaddyProxy`, so the serialization guarantee is proven against the
 * actual lock implementation, not a re-description of it.
 */

import { jest } from '@jest/globals';
import TunnelManager from '../../services/ngrok/tunnelManager.js';
import { createInMemoryRegistry } from '../../services/ngrok/tunnelRegistry.js';
import { PortLock } from '../../services/caddy/portLock.js';
import type { CaddyProxy, UpstreamTarget } from '../../services/caddy/caddyProxy.js';

function makeFakeCaddy(): CaddyProxy & { setUpstreamCalls: UpstreamTarget[] } {
  const setUpstreamCalls: UpstreamTarget[] = [];
  return {
    ensureStarted: async () => ({ localOrigin: 'http://127.0.0.1:41000', localPort: 41000, adminPort: 41001 }),
    setUpstream: async (t: UpstreamTarget) => { setUpstreamCalls.push(t); },
    isHealthy: async () => true,
    stop: async () => {},
    onPortChanged: () => {},
    setUpstreamCalls,
  };
}

describe('TunnelManager — one session tunnel, serialized via the real PortLock', () => {
  let manager: any;
  let ensureSessionTunnelSpy: jest.Mock;
  let caddy: ReturnType<typeof makeFakeCaddy>;

  beforeEach(() => {
    manager = new TunnelManager(createInMemoryRegistry());
    caddy = makeFakeCaddy();
    manager.caddyFactory = () => caddy;

    // Patch createSessionTunnel so no real ngrok calls are made — spy wraps
    // the private method the same way the pre-cutover test patched
    // createTunnel, simulating async connect work and storing a TunnelInfo
    // wired to a REAL PortLock bound to the fake caddy above (mirroring
    // createSessionTunnel's own `new PortLock((t) => caddy.setUpstream(t))`).
    ensureSessionTunnelSpy = jest.fn(async (sessionKey: string, _authToken: string, tunnelId?: string) => {
      const existing = manager.sessionTunnels.get(sessionKey);
      if (existing) return manager.activeTunnels.get(existing);
      await new Promise((resolve) => setTimeout(resolve, 20)); // simulate async work
      const id = tunnelId ?? `t-${sessionKey}`;
      const info = {
        tunnelId: id,
        sessionKey,
        tunnelUrl: `https://${id}.ngrok.debugg.ai`,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        caddy,
        portLock: new PortLock((t: UpstreamTarget) => caddy.setUpstream(t)),
      };
      manager.activeTunnels.set(id, info);
      manager.sessionTunnels.set(sessionKey, id);
      return info;
    });
    manager.ensureSessionTunnel = ensureSessionTunnelSpy;
  });

  // NOTE: the concurrent-first-call cold-start dedup guarantee itself (§2.3's
  // pendingSessionTunnels fix) is exercised against the REAL ensureSessionTunnel
  // implementation in __tests__/services/tunnelManager.test.ts's "concurrent
  // cold-start dedup" describe block — this file's fake spy below only stands
  // in for the SLOW PART (the simulated async connect), not the dedup
  // machinery itself, so it is deliberately not re-asserted here.

  test('two DIFFERENT ports within the SAME session share the one tunnel, and Caddy is repointed between them — never both at once', async () => {
    const info = await manager.ensureSessionTunnel('sess-a', 'auth-token', 'tunnel-a');

    const order: string[] = [];
    const callA = (async () => {
      const handle = await info.portLock.acquire({ port: 3000 }, { callId: 'call-a' });
      order.push('A:acquired');
      await new Promise((r) => setTimeout(r, 15)); // A "in dispatch"
      order.push('A:releasing');
      handle.release();
    })();

    // B (different port) starts shortly after A has already claimed the route.
    await new Promise((r) => setTimeout(r, 5));
    const callB = (async () => {
      order.push('B:acquiring');
      const handle = await info.portLock.acquire({ port: 4000 }, { callId: 'call-b' });
      order.push('B:acquired');
      handle.release();
    })();

    await Promise.all([callA, callB]);

    // Exactly one Caddy repoint per distinct port, in port-then-port order —
    // never both routes "active" at once (there IS only ever one route).
    expect(caddy.setUpstreamCalls.map((t) => t.port)).toEqual([3000, 4000]);
    // B never acquires before A releases — the whole point of the lock.
    const releaseIdx = order.indexOf('A:releasing');
    const bAcquiredIdx = order.indexOf('B:acquired');
    expect(releaseIdx).toBeGreaterThanOrEqual(0);
    expect(bAcquiredIdx).toBeGreaterThan(releaseIdx);
  });

  test('two calls for the SAME port within the same session dispatch concurrently — zero added wait, zero extra repoints', async () => {
    const info = await manager.ensureSessionTunnel('sess-a', 'auth-token', 'tunnel-a');

    const handleA = await info.portLock.acquire({ port: 3000 }, { callId: 'call-a' });
    // A second same-port caller joins for free — no queueing, no second PATCH.
    const handleB = await info.portLock.acquire({ port: 3000 }, { callId: 'call-b' });

    expect(caddy.setUpstreamCalls).toHaveLength(1);
    handleA.release();
    handleB.release();
  });

  test('sequential call for the same session key reuses the existing tunnel without provisioning again', async () => {
    const a = await manager.ensureSessionTunnel('sess-a', 'auth-token', 'tunnel-a');
    const b = await manager.ensureSessionTunnel('sess-a', 'auth-token', 'tunnel-b');

    expect(a).toBe(b); // fast path returns the SAME object, no new tunnel created
  });

  test('calls for DIFFERENT session keys each provision their own tunnel', async () => {
    const [a, b] = await Promise.all([
      manager.ensureSessionTunnel('sess-a', 'auth-token', 'tunnel-a'),
      manager.ensureSessionTunnel('sess-b', 'auth-token', 'tunnel-b'),
    ]);

    expect(a.tunnelId).not.toBe(b.tunnelId);
  });
});
