/**
 * Both tunnel domains are recognised and rewritten (bead debugg_ai_mcp-xkoh.5.3).
 *
 * Requirement (xkoh.5.2 notes R6): during the migration a process can hold an
 * ngrok tunnel and a debugg tunnel at the same time, so every place that knows
 * a tunnel hostname has to know BOTH `*.ngrok.debugg.ai` and
 * `*.tunnel.debugg.ai`. The one that matters for users is replaceTunnelUrls:
 * it is what sanitizeResponseUrls uses to keep a tunnel hostname out of every
 * tool response, so a domain it does not know is a URL that leaks.
 *
 * RED on purpose: utils/urlParser.ts hardcodes `.ngrok.debugg.ai` (L114) and
 * tunnelManager hardcodes it in isTunnelUrl (L455) and extractTunnelId (L459).
 */

import { jest } from '@jest/globals';
import { replaceTunnelUrls, generateTunnelUrl, retargetTunnelUrl } from '../../utils/urlParser.js';

// TunnelManager pulls in ngrok lazily, but constructing one must never spawn or
// download anything in a unit test.
jest.unstable_mockModule('ngrok', () => ({
  connect: jest.fn(),
  disconnect: jest.fn(),
  getApi: jest.fn(),
  default: { connect: jest.fn(), disconnect: jest.fn(), getApi: jest.fn() },
}));
jest.unstable_mockModule('../../services/ngrok/ngrokAgentSession.js', () => ({
  startAgentSession: jest.fn(async (opts: any) => { opts.onStatusChange('connected'); }),
}));

let TunnelManagerClass: typeof import('../../services/ngrok/tunnelManager.js').default;
let createInMemoryRegistry: typeof import('../../services/ngrok/tunnelRegistry.js').createInMemoryRegistry;

beforeAll(async () => {
  ({ default: TunnelManagerClass } = await import('../../services/ngrok/tunnelManager.js'));
  ({ createInMemoryRegistry } = await import('../../services/ngrok/tunnelRegistry.js'));
});

const LOCAL = 'http://localhost:3000';

// ── replaceTunnelUrls: the leak guard ────────────────────────────────────────

describe('replaceTunnelUrls knows both tunnel domains', () => {
  test('rewrites a debugg tunnel URL back to the caller localhost origin', () => {
    expect(replaceTunnelUrls('https://abc-123.tunnel.debugg.ai/dashboard', LOCAL))
      .toBe('http://localhost:3000/dashboard');
  });

  test('still rewrites an ngrok tunnel URL (migration parity)', () => {
    expect(replaceTunnelUrls('https://abc-123.ngrok.debugg.ai/dashboard', LOCAL))
      .toBe('http://localhost:3000/dashboard');
  });

  test('rewrites both domains in one payload — a session can hold one of each', () => {
    const payload = {
      screenshot: 'https://a.ngrok.debugg.ai/shot.png',
      nested: { target: 'https://b.tunnel.debugg.ai/login?next=/x' },
      list: ['https://c.tunnel.debugg.ai/'],
    };

    expect(replaceTunnelUrls(payload, LOCAL)).toEqual({
      screenshot: 'http://localhost:3000/shot.png',
      nested: { target: 'http://localhost:3000/login?next=/x' },
      list: ['http://localhost:3000/'],
    });
  });

  test('leaves other debugg.ai hosts alone — only tunnel hostnames are rewritten', () => {
    const text = 'see https://api.debugg.ai/docs and https://app.debugg.ai/runs/1';
    expect(replaceTunnelUrls(text, LOCAL)).toBe(text);
  });
});

// ── URL construction and parsing ─────────────────────────────────────────────

describe('tunnel URL construction and parsing', () => {
  test('generateTunnelUrl builds a debugg tunnel URL when given the domain', () => {
    expect(generateTunnelUrl('http://localhost:3000/x?y=1', 'tid', 'tunnel.debugg.ai'))
      .toBe('https://tid.tunnel.debugg.ai/x?y=1');
  });

  test('retargetTunnelUrl composes a debugg origin with this caller path', () => {
    expect(retargetTunnelUrl('https://tid.tunnel.debugg.ai', 'http://localhost:3000/deep?a=b#c'))
      .toBe('https://tid.tunnel.debugg.ai/deep?a=b#c');
  });

  test('isTunnelUrl recognises both domains and nothing else', () => {
    const tm = new TunnelManagerClass(createInMemoryRegistry());
    expect(tm.isTunnelUrl('https://abc.tunnel.debugg.ai')).toBe(true);
    expect(tm.isTunnelUrl('https://abc.tunnel.debugg.ai/path')).toBe(true);
    expect(tm.isTunnelUrl('https://abc.ngrok.debugg.ai')).toBe(true);
    expect(tm.isTunnelUrl('https://api.debugg.ai/v1')).toBe(false);
    expect(tm.isTunnelUrl('http://localhost:3000')).toBe(false);
  });

  test('extractTunnelId parses the subdomain of either domain', () => {
    const tm = new TunnelManagerClass(createInMemoryRegistry());
    expect(tm.extractTunnelId('https://abc-123.tunnel.debugg.ai/api')).toBe('abc-123');
    expect(tm.extractTunnelId('https://abc-123.ngrok.debugg.ai/api')).toBe('abc-123');
    expect(tm.extractTunnelId('https://api.debugg.ai/v1')).toBeNull();
  });
});
