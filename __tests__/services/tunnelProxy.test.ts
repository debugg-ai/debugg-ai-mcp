/**
 * services/tunnel/proxy.ts — proxy selection for the tunnel websocket
 * (bead platform-neog). Pure: the environment is passed in, never read.
 */
import { resolveTunnelProxy, noProxyMatches } from '../../services/tunnel/proxy.js';

const RELAY = 'wss://api.debugg.ai/tunnel/v1/connect';

describe('resolveTunnelProxy', () => {
  test('no proxy variable: undefined', () => {
    expect(resolveTunnelProxy(RELAY, {})).toBeUndefined();
  });

  test.each(['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'])('%s selects the proxy', (name) => {
    const r = resolveTunnelProxy(RELAY, { [name]: 'http://corp:3128' });
    expect(r?.varName).toBe(name);
    expect(r?.display).toBe('corp:3128');
    expect(r?.agent).toBeDefined();
  });

  test('HTTPS_PROXY wins over ALL_PROXY', () => {
    const r = resolveTunnelProxy(RELAY, { ALL_PROXY: 'http://b:1', HTTPS_PROXY: 'http://a:2' });
    expect(r?.display).toBe('a:2');
  });

  test('a scheme-less proxy value is treated as http://', () => {
    expect(resolveTunnelProxy(RELAY, { HTTPS_PROXY: 'corp:3128' })?.display).toBe('corp:3128');
  });

  test('credentials never appear in display', () => {
    const r = resolveTunnelProxy(RELAY, { HTTPS_PROXY: 'http://alice:s3cret@corp:3128' });
    expect(r?.display).toBe('corp:3128');
    expect(JSON.stringify(r?.display)).not.toMatch(/alice|s3cret/);
  });

  test('NO_PROXY match bypasses', () => {
    expect(resolveTunnelProxy(RELAY, { HTTPS_PROXY: 'http://corp:3128', NO_PROXY: 'api.debugg.ai' })).toBeUndefined();
    expect(resolveTunnelProxy(RELAY, { HTTPS_PROXY: 'http://corp:3128', no_proxy: '.debugg.ai' })).toBeUndefined();
  });

  test('an unsupported (socks) scheme is not used', () => {
    expect(resolveTunnelProxy(RELAY, { ALL_PROXY: 'socks5://corp:1080' })).toBeUndefined();
  });

  test('an unparseable value is ignored', () => {
    expect(resolveTunnelProxy(RELAY, { HTTPS_PROXY: 'http://' })).toBeUndefined();
  });
});

describe('noProxyMatches', () => {
  const m = (list: string, url = RELAY) => noProxyMatches(new URL(url), list);

  test('exact host', () => { expect(m('api.debugg.ai')).toBe(true); });
  test('other host', () => { expect(m('example.com')).toBe(false); });
  test('leading-dot suffix', () => { expect(m('.debugg.ai')).toBe(true); });
  test('wildcard suffix', () => { expect(m('*.debugg.ai')).toBe(true); });
  test('bare domain matches subdomains', () => { expect(m('debugg.ai')).toBe(true); });
  test('no partial-label match', () => { expect(m('gg.ai')).toBe(false); });
  test('star matches all', () => { expect(m('*')).toBe(true); });
  test('comma and space separated lists', () => {
    expect(m('foo.com, bar.com  api.debugg.ai')).toBe(true);
  });
  test('port must match when given (default 443 for wss)', () => {
    expect(m('api.debugg.ai:443')).toBe(true);
    expect(m('api.debugg.ai:8443')).toBe(false);
    expect(m('api.debugg.ai:8443', 'wss://api.debugg.ai:8443/x')).toBe(true);
  });
  test('case-insensitive', () => { expect(m('API.Debugg.AI')).toBe(true); });
  test('empty', () => { expect(m('')).toBe(false); });
});
