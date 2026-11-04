/**
 * The debugg transport's websocket through an HTTP CONNECT proxy
 * (bead platform-neog). A real in-process CONNECT proxy in front of the repo's
 * in-process fake tunnel server. No caddy needed: only the transport is real.
 */
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';

import { createDebuggTransport } from '../../services/tunnel/debuggTransport.js';
import { FakeTunnelServerForTests } from './debuggTunnelServer.js';

const TUNNEL_ID = 'proxy-tunnel';
const HOSTNAME = `${TUNNEL_ID}.tunnel.debugg.ai`;
const TOKEN = 'tunnel-key-SECRET';

interface FakeProxy {
  port: number;
  connects: Array<{ target: string; auth: string | undefined }>;
  close(): Promise<void>;
}

/** CONNECT proxy. `requireAuth` makes it demand Basic user:pass (else 407). */
async function startProxy(requireAuth?: string): Promise<FakeProxy> {
  const connects: FakeProxy['connects'] = [];
  const conns = new Set<net.Socket>();
  const server = http.createServer((_req, res) => { res.writeHead(405).end(); });
  server.on('connect', (req, clientSock, head) => {
    const auth = req.headers['proxy-authorization'];
    connects.push({ target: req.url ?? '', auth });
    conns.add(clientSock);
    if (requireAuth) {
      const expected = 'Basic ' + Buffer.from(requireAuth).toString('base64');
      if (auth !== expected) {
        clientSock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="corp"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
    }
    const [host, port] = (req.url ?? '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(clientSock);
      clientSock.pipe(upstream);
    });
    conns.add(upstream);
    upstream.on('error', () => clientSock.destroy());
    clientSock.on('error', () => upstream.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    connects,
    close: () => new Promise<void>((r) => {
      for (const s of conns) s.destroy();
      server.close(() => r());
    }),
  };
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];

describe('debugg tunnel through an HTTP CONNECT proxy', () => {
  const saved: Record<string, string | undefined> = {};
  let server: FakeTunnelServerForTests;
  let proxy: FakeProxy | undefined;
  const transport = () => createDebuggTransport({ handshakeTimeoutMs: 5000 });
  const connect = (t = transport(), relayUrl = server.relayUrl) =>
    t.connect('http://127.0.0.1:1', HOSTNAME, TOKEN, { tunnelId: TUNNEL_ID, relayUrl });
  let t: ReturnType<typeof transport> | undefined;

  beforeEach(async () => {
    for (const v of PROXY_VARS) { saved[v] = process.env[v]; delete process.env[v]; }
    server = new FakeTunnelServerForTests(HOSTNAME);
    await server.start();
  });
  afterEach(async () => {
    for (const v of PROXY_VARS) {
      if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v];
    }
    if (t) await t.disconnect(`https://${HOSTNAME}`).catch(() => undefined);
    t = undefined;
    await server.stop();
    await proxy?.close();
    proxy = undefined;
  });

  test('no proxy set: connects directly, nothing goes through a proxy', async () => {
    proxy = await startProxy();
    t = transport();
    await connect(t);
    expect(server.connected).toBe(true);
    expect(proxy.connects).toHaveLength(0);
  });

  test('HTTPS_PROXY set: the websocket goes through CONNECT to the relay', async () => {
    proxy = await startProxy();
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
    t = transport();
    await connect(t);
    expect(server.connected).toBe(true);
    expect(proxy.connects).toEqual([{ target: `127.0.0.1:${server.controlPort}`, auth: undefined }]);
    // the handshake still reached the server with the key header
    expect(server.handshakes).toHaveLength(1);
  });

  test('user:pass@ in the proxy URL is sent as Basic proxy auth', async () => {
    proxy = await startProxy('alice:p@ss');
    process.env.HTTPS_PROXY = `http://alice:p%40ss@127.0.0.1:${proxy.port}`;
    t = transport();
    await connect(t);
    expect(server.connected).toBe(true);
    expect(proxy.connects[0].auth).toBe('Basic ' + Buffer.from('alice:p@ss').toString('base64'));
  });

  test('NO_PROXY covering the relay host bypasses the proxy', async () => {
    proxy = await startProxy();
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
    process.env.NO_PROXY = 'localhost, 127.0.0.1';
    t = transport();
    await connect(t);
    expect(server.connected).toBe(true);
    expect(proxy.connects).toHaveLength(0);
  });

  test('407 from the proxy: clear error naming the proxy, no credentials', async () => {
    proxy = await startProxy('alice:right-password');
    process.env.HTTPS_PROXY = `http://alice:WRONG-pw@127.0.0.1:${proxy.port}`;
    const err = await connect().then(() => null, (e) => e);
    expect(err).not.toBeNull();
    expect(err.message).toContain('407');
    expect(err.message).toContain(`127.0.0.1:${proxy.port}`);
    expect(err.message).toMatch(/proxy/i);
    expect(err.message).not.toMatch(/alice|WRONG-pw|right-password|tunnel-key-SECRET/);
    expect(err.message).not.toMatch(/not supported/i);
  });

  test('unreachable proxy: says the proxy could not be reached', async () => {
    const dead = await startProxy();
    const port = dead.port;
    await dead.close();
    process.env.HTTPS_PROXY = `http://bob:hunter2@127.0.0.1:${port}`;
    const err = await connect().then(() => null, (e) => e);
    expect(err).not.toBeNull();
    expect(err.message).toMatch(/could not (connect|reach)/i);
    expect(err.message).toContain(`proxy 127.0.0.1:${port}`);
    expect(err.message).not.toMatch(/bob|hunter2|tunnel-key-SECRET/);
    expect(err.retryable).not.toBe(false);
  });
});
