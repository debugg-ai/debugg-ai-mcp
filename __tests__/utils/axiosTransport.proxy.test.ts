/**
 * REST client through an HTTP proxy (platform-y2ob.3): a CONNECT-only proxy
 * must be reachable, because axios's own env-proxy handling sends an
 * absolute-URI request that such proxies answer 405.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AxiosTransport } from '../../utils/axiosTransport.js';

const servers: Array<http.Server | https.Server> = [];
afterAll(() => servers.forEach((s) => s.close()));

function listen(s: http.Server | https.Server): Promise<number> {
  servers.push(s);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));
}

async function connectOnlyProxy(opts: { deny407?: boolean } = {}) {
  const connects: string[] = [];
  const other: string[] = [];
  const s = http.createServer((req, res) => {
    other.push(`${req.method} ${req.url}`);
    res.writeHead(405).end('Method Not Allowed');
  });
  s.on('connect', (req, sock) => {
    connects.push(req.url!);
    if (opts.deny407) {
      sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="x"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const [host, port] = req.url!.split(':');
    const up = net.connect(Number(port), host, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  const port = await listen(s);
  return { port, connects, other };
}

async function plainApi() {
  const s = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ some_field: 1 }));
  });
  return { port: await listen(s) };
}

describe('AxiosTransport behind an HTTP proxy', () => {
  test('http API: request goes through CONNECT and succeeds', async () => {
    const api = await plainApi();
    const proxy = await connectOnlyProxy();
    const tx = new AxiosTransport({
      baseUrl: `http://127.0.0.1:${api.port}/`,
      apiKey: 'k',
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` },
    });
    await expect(tx.get('api/v1/ping')).resolves.toEqual({ someField: 1 });
    expect(proxy.connects).toEqual([`127.0.0.1:${api.port}`]);
    expect(proxy.other).toEqual([]);
  });

  const tlsTest = typeof (tls as any).setDefaultCACertificates === 'function' ? test : test.skip;
  tlsTest('https API (self-signed): request goes through CONNECT and succeeds', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'axproxy-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'),
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    const cert = readFileSync(path.join(dir, 'c.pem'));
    const s = https.createServer({ key: readFileSync(path.join(dir, 'k.pem')), cert }, (_q, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok_value: true }));
    });
    const apiPort = await listen(s);
    const proxy = await connectOnlyProxy();
    const tx = new AxiosTransport({
      baseUrl: `https://localhost:${apiPort}/`,
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` },
    });
    // Trust the self-signed cert for this test only (Node >= 22.19).
    const before = tls.getCACertificates('default');
    tls.setDefaultCACertificates([...before, cert.toString()]);
    try {
      await expect(tx.get('x')).resolves.toEqual({ okValue: true });
    } finally {
      tls.setDefaultCACertificates(before);
    }
    expect(proxy.connects).toEqual([`localhost:${apiPort}`]);
  });

  test('proxy credentials in the URL are sent', async () => {
    const api = await plainApi();
    let auth: string | undefined;
    const s = http.createServer();
    s.on('connect', (req, sock) => {
      auth = req.headers['proxy-authorization'] as string | undefined;
      const up = net.connect(api.port, '127.0.0.1', () => {
        sock.write('HTTP/1.1 200 OK\r\n\r\n');
        up.pipe(sock); sock.pipe(up);
      });
    });
    const pp = await listen(s);
    const tx = new AxiosTransport({
      baseUrl: `http://127.0.0.1:${api.port}/`,
      env: { HTTPS_PROXY: `http://alice:s3cret@127.0.0.1:${pp}` },
    });
    await tx.get('x');
    expect(auth).toBe('Basic ' + Buffer.from('alice:s3cret').toString('base64'));
  });

  test('NO_PROXY match bypasses the proxy', async () => {
    const api = await plainApi();
    const proxy = await connectOnlyProxy();
    const tx = new AxiosTransport({
      baseUrl: `http://127.0.0.1:${api.port}/`,
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: '127.0.0.1' },
    });
    await expect(tx.get('x')).resolves.toEqual({ someField: 1 });
    expect(proxy.connects).toEqual([]);
  });

  test('407 names the proxy host, never the credentials', async () => {
    const proxy = await connectOnlyProxy({ deny407: true });
    const tx = new AxiosTransport({
      baseUrl: 'http://127.0.0.1:9/',
      env: { HTTPS_PROXY: `http://alice:s3cret@127.0.0.1:${proxy.port}` },
    });
    const err: any = await tx.get('x').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(`127.0.0.1:${proxy.port}`);
    expect(err.message).toContain('407');
    expect(err.message).not.toMatch(/alice|s3cret/);
  });

  test('no proxy: axios config carries no agent and no proxy override', () => {
    const tx = new AxiosTransport({ baseUrl: 'http://127.0.0.1:9/', env: {} });
    expect(tx.axios.defaults.httpAgent).toBeUndefined();
    expect(tx.axios.defaults.httpsAgent).toBeUndefined();
    expect(tx.axios.defaults.proxy).toBeUndefined();
  });
});
