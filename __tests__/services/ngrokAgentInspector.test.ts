/**
 * Local ngrok agent inspector tests (bead lc62).
 *
 * The agent fetch is injected, so nothing here opens a socket. The one thing
 * worth stating up front: every failure mode must degrade to an EMPTY LIST,
 * because TunnelManager consumes this add-only and an empty list is what makes
 * "the inspector learned nothing" cost exactly nothing.
 */

import { describe, test, expect } from '@jest/globals';
import { createServer, type ServerResponse } from 'node:http';
import {
  createLocalAgentInspector,
  parseAgentTunnels,
  portFromAgentAddr,
  noopInspector,
} from '../../services/ngrok/ngrokAgentInspector.js';

/** A realistic /api/tunnels body, as ngrok agent v3 actually serves it. */
function agentBody(tunnels: Array<{ url: string; addr: string }>): string {
  return JSON.stringify({
    tunnels: tunnels.map(({ url, addr }) => ({
      name: 'command_line',
      ID: 'abc123',
      uri: '/api/tunnels/command_line',
      public_url: url,
      proto: 'https',
      config: { addr, inspect: true },
      metrics: { conns: {}, http: {} },
    })),
    uri: '/api/tunnels',
  });
}

describe('portFromAgentAddr', () => {
  test.each([
    ['http://127.0.0.1:3011', 3011],
    ['https://localhost:3443', 3443],
    ['localhost:3011', 3011],       // bare host:port — ngrok reports this shape too
    ['127.0.0.1:8080', 8080],
    ['host.docker.internal:4001', 4001],
  ])('%s → %s', (addr, expected) => {
    expect(portFromAgentAddr(addr)).toBe(expected);
  });

  test.each([
    ['http://127.0.0.1'],           // no port at all
    ['file:///tmp/sock'],
    [''],
    ['nonsense'],
  ])('%s → undefined rather than a guess', (addr) => {
    expect(portFromAgentAddr(addr)).toBeUndefined();
  });
});

describe('parseAgentTunnels', () => {
  test('extracts tunnelId, publicUrl and local port', () => {
    const parsed = parseAgentTunnels(
      agentBody([{ url: 'https://abc-123.ngrok.debugg.ai', addr: 'http://127.0.0.1:3011' }]),
    );
    expect(parsed).toEqual([
      { tunnelId: 'abc-123', publicUrl: 'https://abc-123.ngrok.debugg.ai', port: 3011 },
    ]);
  });

  // ── The line we must never cross ────────────────────────────────────────────
  test('IGNORES tunnels that are not ours — a developer\'s own ngrok is off limits', () => {
    const parsed = parseAgentTunnels(agentBody([
      { url: 'https://random-slug.ngrok-free.app', addr: 'http://127.0.0.1:3000' },
      { url: 'https://tunnel.mycompany.com', addr: 'http://127.0.0.1:3001' },
      { url: 'https://ours.ngrok.debugg.ai', addr: 'http://127.0.0.1:3002' },
    ]));
    expect(parsed.map((t) => t.tunnelId)).toEqual(['ours']);
  });

  test('a lookalike suffix does not qualify', () => {
    const parsed = parseAgentTunnels(agentBody([
      { url: 'https://x.ngrok.debugg.ai.evil.com', addr: 'http://127.0.0.1:3000' },
      { url: 'https://x.notngrok.debugg.ai', addr: 'http://127.0.0.1:3001' },
    ]));
    expect(parsed).toEqual([]);
  });

  test('a multi-label subdomain is not a tunnelId we minted', () => {
    const parsed = parseAgentTunnels(
      agentBody([{ url: 'https://a.b.ngrok.debugg.ai', addr: 'http://127.0.0.1:3000' }]),
    );
    expect(parsed).toEqual([]);
  });

  test('de-duplicates a tunnel the agent lists once per proto', () => {
    const body = JSON.stringify({
      tunnels: [
        { public_url: 'https://dup.ngrok.debugg.ai', config: { addr: 'http://127.0.0.1:3011' } },
        { public_url: 'http://dup.ngrok.debugg.ai', config: { addr: 'http://127.0.0.1:3011' } },
      ],
    });
    expect(parseAgentTunnels(body)).toHaveLength(1);
  });

  test('entries without a parseable local port are dropped, siblings survive', () => {
    const parsed = parseAgentTunnels(agentBody([
      { url: 'https://noport.ngrok.debugg.ai', addr: 'http://127.0.0.1' },
      { url: 'https://fine.ngrok.debugg.ai', addr: 'http://127.0.0.1:3011' },
    ]));
    expect(parsed.map((t) => t.tunnelId)).toEqual(['fine']);
  });

  test.each([
    ['not json at all'],
    ['{}'],
    ['{"tunnels":null}'],
    ['{"tunnels":"nope"}'],
    ['{"tunnels":[{"public_url":123}]}'],
    ['[]'],
  ])('malformed body %s → [] rather than a throw', (body) => {
    expect(parseAgentTunnels(body)).toEqual([]);
  });
});

describe('createLocalAgentInspector', () => {
  test('unions tunnels across every agent that answers', async () => {
    const inspector = createLocalAgentInspector({
      ports: [4040, 4041, 4042],
      faultMode: null,
      fetchAgentTunnels: async (port) => {
        if (port === 4040) return agentBody([{ url: 'https://a.ngrok.debugg.ai', addr: '127.0.0.1:3000' }]);
        if (port === 4042) return agentBody([{ url: 'https://b.ngrok.debugg.ai', addr: '127.0.0.1:4000' }]);
        return undefined; // 4041: nothing listening
      },
    });

    const live = await inspector.listLiveTunnels();
    expect(live.map((t) => t.tunnelId).sort()).toEqual(['a', 'b']);
  });

  test('the same tunnel seen on two agents is reported once', async () => {
    const body = agentBody([{ url: 'https://same.ngrok.debugg.ai', addr: '127.0.0.1:3000' }]);
    const inspector = createLocalAgentInspector({
      ports: [4040, 4041],
      faultMode: null,
      fetchAgentTunnels: async () => body,
    });
    expect(await inspector.listLiveTunnels()).toHaveLength(1);
  });

  // ── The safety property ────────────────────────────────────────────────────
  test('NO agent reachable → empty list, never a throw', async () => {
    const inspector = createLocalAgentInspector({
      ports: [4040, 4041],
      faultMode: null,
      fetchAgentTunnels: async () => undefined,
    });
    await expect(inspector.listLiveTunnels()).resolves.toEqual([]);
  });

  test('an agent fetch that REJECTS is absorbed; the others still count', async () => {
    const inspector = createLocalAgentInspector({
      ports: [4040, 4041],
      faultMode: null,
      fetchAgentTunnels: async (port) => {
        if (port === 4040) throw new Error('ECONNRESET');
        return agentBody([{ url: 'https://survivor.ngrok.debugg.ai', addr: '127.0.0.1:3000' }]);
      },
    });
    expect((await inspector.listLiveTunnels()).map((t) => t.tunnelId)).toEqual(['survivor']);
  });

  test('scans ngrok\'s whole inspector port walk by default (4040 upward)', async () => {
    const seen: number[] = [];
    const inspector = createLocalAgentInspector({
      faultMode: null,
      fetchAgentTunnels: async (port) => { seen.push(port); return undefined; },
    });
    await inspector.listLiveTunnels();
    // ngrok increments from 4040 when the port is taken, so a single-port scan
    // would miss every agent but the first.
    expect(seen[0]).toBe(4040);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  test('noopInspector observes nothing — the default under NODE_ENV=test', async () => {
    await expect(noopInspector.listLiveTunnels()).resolves.toEqual([]);
  });
});

// The default transport is otherwise bypassed by the injected fetch above, so
// these stand up a real loopback server and exercise node:http for real.
describe('default loopback transport', () => {
  async function withAgent(
    handler: (req: unknown, res: ServerResponse) => void,
    run: (port: number) => Promise<void>,
  ): Promise<void> {
    const server = createServer(handler as never);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    try {
      await run(port);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  test('reads a real agent response over 127.0.0.1', async () => {
    await withAgent(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(agentBody([{ url: 'https://real-t.ngrok.debugg.ai', addr: 'http://127.0.0.1:3011' }]));
      },
      async (port) => {
        const live = await createLocalAgentInspector({ ports: [port], faultMode: null }).listLiveTunnels();
        expect(live).toEqual([
          { tunnelId: 'real-t', publicUrl: 'https://real-t.ngrok.debugg.ai', port: 3011 },
        ]);
      },
    );
  });

  test('a non-200 from something else squatting the port yields nothing', async () => {
    await withAgent(
      (_req, res) => { res.writeHead(404); res.end('not an ngrok agent'); },
      async (port) => {
        const live = await createLocalAgentInspector({ ports: [port], faultMode: null }).listLiveTunnels();
        expect(live).toEqual([]);
      },
    );
  });

  test('a closed port is a plain miss, not an error', async () => {
    // Port 1 is reserved and nothing will be listening.
    const live = await createLocalAgentInspector({
      ports: [1], timeoutMs: 300, faultMode: null,
    }).listLiveTunnels();
    expect(live).toEqual([]);
  });

  test('a hung agent times out instead of stalling the whole scan', async () => {
    await withAgent(
      () => { /* never respond */ },
      async (port) => {
        const started = Date.now();
        const live = await createLocalAgentInspector({
          ports: [port], timeoutMs: 100, faultMode: null,
        }).listLiveTunnels();
        expect(live).toEqual([]);
        // A tunnel request must never wait on a wedged agent.
        expect(Date.now() - started).toBeLessThan(3000);
      },
    );
  });
});

describe('bead 42g fault modes', () => {
  test('inspector-unreachable forces the learned-nothing path without any fetch', async () => {
    const fetchAgentTunnels = async () => agentBody([
      { url: 'https://would-be-found.ngrok.debugg.ai', addr: '127.0.0.1:3000' },
    ]);
    const inspector = createLocalAgentInspector({
      ports: [4040],
      faultMode: { inspectorUnreachable: true },
      fetchAgentTunnels,
    });
    expect(await inspector.listLiveTunnels()).toEqual([]);
  });

  test('inspector-adopt reports a synthetic live tunnel on the requested port', async () => {
    const inspector = createLocalAgentInspector({
      ports: [4040],
      faultMode: { inspectorAdoptPort: 3011 },
      fetchAgentTunnels: async () => undefined,
    });
    const live = await inspector.listLiveTunnels();
    expect(live).toHaveLength(1);
    expect(live[0].port).toBe(3011);
    // Still has to satisfy the ownership filter it is standing in for.
    expect(live[0].publicUrl.endsWith('.ngrok.debugg.ai')).toBe(true);
  });
});
