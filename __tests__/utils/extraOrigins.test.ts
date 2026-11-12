import { describe, test, expect } from '@jest/globals';
import { retargetAuxiliaryUrl, type TunnelContext } from '../../utils/tunnelContext.js';
import { parseExtraOrigin, ExtraOriginError } from '../../utils/extraOrigins.js';
import { buildLocationRewrites, buildAuxSubroute, buildPatchBody, buildCaddyConfig } from '../../services/caddy/caddyProxy.js';

describe('parseExtraOrigin (bead w1os.2)', () => {
  test.each([
    ['4304', { port: 4304 }],
    ['localhost:4304', { port: 4304 }],
    ['http://host.docker.internal:4717', { port: 4717 }],
    ['http://127.0.0.1:4717/oauth/authorize?x=1', { port: 4717 }],
    ['https://localhost:8443', { port: 8443, isHttpsLocal: true }],
  ])('%s', (raw, want) => expect(parseExtraOrigin(raw)).toEqual(want));
  test.each(['example.com:80', 'http://evil.example:4717', 'ftp://localhost:1', '0', '70000', ''])('rejects %s', (raw) => {
    expect(() => parseExtraOrigin(raw)).toThrow(ExtraOriginError);
  });
});

describe('caddy aux config', () => {
  test('Location rewrites map every local alias of aux and primary ports onto the tunnel', () => {
    const rules = buildLocationRewrites(4300, [{ port: 4717 }]);
    const aux = new RegExp(rules[0].search_regexp);
    expect(aux.test('http://host.docker.internal:4717/oauth/authorize?a=1')).toBe(true);
    expect(aux.test('http://localhost:4717')).toBe(true);
    expect(aux.test('http://localhost:47170/x')).toBe(false);
    expect(aux.test('http://evil.example:4717/x')).toBe(false);
    expect(rules[0].replace).toBe('/__o/4717/${1}');
    expect(rules[1].replace).toBe('/__o/4300/${1}');
  });
  test('aux subroute: prefixed + Referer-scoped route per origin (incl. primary), prefix stripped only on the prefixed one', () => {
    const sub: any = buildAuxSubroute([{ port: 4717 }], { port: 4300 }, false);
    expect(sub.routes).toHaveLength(4); // (4717, 4300) x (prefixed, referer)
    expect(sub.routes[0].match[0].path).toEqual(['/__o/4717/*']);
    expect(sub.routes[0].handle[0]).toEqual({ handler: 'rewrite', strip_path_prefix: '/__o/4717' });
    expect(sub.routes[0].handle[1].upstreams[0].dial).toBe('127.0.0.1:4717');
    const ref = sub.routes[2];
    expect(ref.match[0].not[0].path).toEqual(['/__o/*']);
    expect(new RegExp(ref.match[0].header_regexp.Referer.pattern).test('https://t.example/__o/4717/consent?x=1')).toBe(true);
    expect(new RegExp(ref.match[0].header_regexp.Referer.pattern).test('https://t.example/__o/47170/x')).toBe(false);
    expect(ref.handle).toHaveLength(1); // no strip: the path is already origin-relative
  });
  test('no aux origins => no per-origin routes at all', () => {
    expect((buildAuxSubroute([], { port: 4300 }, false) as any).routes).toEqual([]);
  });
  test('no aux => primary patch body is unchanged (no headers block)', () => {
    expect(buildPatchBody({ port: 4300 }, false)).not.toHaveProperty('headers');
    expect(buildPatchBody({ port: 4300 }, false, [{ port: 4717 }])).toHaveProperty('headers.response.replace.Location');
  });
  test('aux route precedes the primary catch-all', () => {
    const cfg = buildCaddyConfig(1, 2);
    expect((cfg.apps.http.servers.srv0.routes[0].handle[0] as any)['@id']).toBe('dbg-aux');
    expect((cfg.apps.http.servers.srv0.routes[1].handle[0] as any)['@id']).toBe('dbg-handler');
  });
});

describe('retargetAuxiliaryUrl with extraOrigins', () => {
  const ctx: TunnelContext = {
    originalUrl: 'http://localhost:4300/', isLocalhost: true, tunnelId: 't1',
    targetUrl: 'https://t1.tunnel.example/', extraOrigins: [{ port: 4717 }],
  };
  test('authorised other port goes to /__o/<port>/', () => {
    expect(retargetAuxiliaryUrl(ctx, 'http://localhost:4717/oauth?x=1')).toEqual({
      ok: true, url: 'https://t1.tunnel.example/__o/4717/oauth?x=1', rewritten: true,
    });
  });
  test('unlisted other port is still refused', () => {
    expect(retargetAuxiliaryUrl(ctx, 'http://localhost:9999/x')).toMatchObject({ ok: false, reason: 'port_mismatch' });
  });
});
