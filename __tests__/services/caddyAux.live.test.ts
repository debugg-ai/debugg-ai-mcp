/**
 * Real-Caddy test for extra local origins (bead w1os.2): an OAuth-shaped redirect
 * chain app -> host.docker.internal:vendor -> localhost:callback -> app must be
 * followable entirely through the proxy's origin. Skips when no caddy binary.
 */
import { describe, test, expect, afterAll } from '@jest/globals';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createCaddyProxy, findBundledCaddyBinary } from '../../services/caddy/caddyProxy.js';

function haveCaddy(): boolean {
  if (process.env.CADDY_BIN || findBundledCaddyBinary()) return true;
  try { execFileSync('caddy', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const run = haveCaddy() ? describe : describe.skip;

const listen = (h: http.RequestListener) =>
  new Promise<http.Server>((r) => { const s = http.createServer(h).listen(0, '127.0.0.1', () => r(s)); });
const port = (s: http.Server) => (s.address() as { port: number }).port;

run('caddy aux origins (live)', () => {
  const servers: http.Server[] = [];
  const caddy = createCaddyProxy();
  afterAll(async () => { await caddy.stop(); servers.forEach((s) => s.close()); });

  test('follows app -> vendor -> callback -> app through one origin; unlisted port is not proxied', async () => {
    let B!: http.Server, C!: http.Server;
    const A = await listen((q, s) => {
      if (q.url === '/start') { s.writeHead(302, { Location: `http://host.docker.internal:${port(B)}/oauth/authorize?x=1` }); s.end(); }
      else if (q.url === '/page2') s.end('PRIMARY-PAGE2');
      else s.end('APP ' + q.url);
    });
    B = await listen((q, s) => {
      if (q.url === '/allow' || q.url!.startsWith('/oauth/authorize')) { s.writeHead(302, { Location: `http://localhost:${port(C)}/cb?code=1` }); s.end(); }
      else s.end('VENDOR ' + q.url); // root-relative asset/form target on the vendor
    });
    C = await listen((_q, s) => { s.writeHead(302, { Location: `http://localhost:${port(A)}/done` }); s.end(); });
    const D = await listen((_q, s) => s.end('SECRET'));
    servers.push(A, B, C, D);

    const { localOrigin } = await caddy.ensureStarted();
    await caddy.setUpstream({ port: port(A) });
    await caddy.addAuxOrigins([{ port: port(B) }, { port: port(C) }]);
    await caddy.addAuxOrigins([{ port: port(B) }]); // idempotent

    const hops: string[] = [];
    let url = `${localOrigin}/start`;
    let body = '';
    for (let i = 0; i < 6; i++) {
      const r = await fetch(url, { redirect: 'manual' });
      const loc = r.headers.get('location');
      hops.push(url.replace(localOrigin, ''));
      if (!loc) { body = await r.text(); break; }
      url = new URL(loc, localOrigin).toString();
    }
    expect(hops).toEqual(['/start', `/__o/${port(B)}/oauth/authorize?x=1`, `/__o/${port(C)}/cb?code=1`, `/__o/${port(A)}/done`]);
    expect(body).toBe('APP /done');

    // Root-relative request from a vendor page stays on the vendor (Referer-scoped)...
    const fromVendor = await fetch(`${localOrigin}/allow`, { headers: { Referer: `${localOrigin}/__o/${port(B)}/consent` }, redirect: 'manual' });
    expect(fromVendor.status).toBe(302);
    expect(fromVendor.headers.get('location')).toBe(`/__o/${port(C)}/cb?code=1`);
    // ...and one from the primary's prefixed page reaches the primary, not the vendor.
    const fromApp = await (await fetch(`${localOrigin}/page2`, { headers: { Referer: `${localOrigin}/__o/${port(A)}/done` } })).text();
    expect(fromApp).toBe('PRIMARY-PAGE2');
    // No Referer: primary.
    expect(await (await fetch(`${localOrigin}/page2`)).text()).toBe('PRIMARY-PAGE2');
    // A forged Referer naming an unauthorised port does not reach it.
    const forged = await (await fetch(`${localOrigin}/x`, { headers: { Referer: `${localOrigin}/__o/${port(D)}/` } })).text();
    expect(forged).not.toContain('SECRET');

    const blocked = await (await fetch(`${localOrigin}/__o/${port(D)}/x`)).text();
    expect(blocked).not.toContain('SECRET');
  }, 30000);
});
