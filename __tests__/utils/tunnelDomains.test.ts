/**
 * Every tunnel domain is recognised and rewritten (bead debugg_ai_mcp-xkoh.5.3,
 * then .6.4).
 *
 * Requirement (xkoh.5.2 notes R6): every place that knows a tunnel hostname has
 * to know BOTH `*.tunnel.debugg.ai` and the retired `*.ngrok.debugg.ai`. The
 * one that matters for users is replaceTunnelUrls: it is what
 * sanitizeResponseUrls uses to keep a tunnel hostname out of every tool
 * response, so a domain it does not know is a URL that leaks.
 *
 * ── THE ngrok CASES ARE A DELIBERATE KEEP, NOT LEFTOVERS ────────────────────
 * The ngrok transport is deleted; this client cannot create an
 * `*.ngrok.debugg.ai` tunnel any more. Those hostnames are still recognised
 * because a BACKEND RESPONSE ABOUT A HISTORICAL RUN can still carry one, and
 * an unrecognised tunnel hostname is one that leaks to the caller verbatim.
 * The tests below are the lock that stops the entry being tidied away as dead
 * code — see the box in utils/tunnelDomains.ts. Retire both together under
 * bead debugg_ai_mcp-xkoh.6.6.
 */

import TunnelManagerClass from '../../services/tunnel/tunnelManager.js';
import { createInMemoryRegistry } from '../../services/tunnel/tunnelRegistry.js';
import { replaceTunnelUrls, generateTunnelUrl, retargetTunnelUrl } from '../../utils/urlParser.js';

const LOCAL = 'http://localhost:3000';

// ── replaceTunnelUrls: the leak guard ────────────────────────────────────────

describe('replaceTunnelUrls knows both tunnel domains', () => {
  test('rewrites a debugg tunnel URL back to the caller localhost origin', () => {
    expect(replaceTunnelUrls('https://abc-123.tunnel.debugg.ai/dashboard', LOCAL))
      .toBe('http://localhost:3000/dashboard');
  });

  test('LOCK: still rewrites a historical ngrok tunnel URL', () => {
    expect(replaceTunnelUrls('https://abc-123.ngrok.debugg.ai/dashboard', LOCAL))
      .toBe('http://localhost:3000/dashboard');
  });

  test('rewrites both domains in one payload — a response can carry a live and a historical URL', () => {
    const payload = {
      screenshot: 'https://a.ngrok.debugg.ai/shot.png', // stored by a historical run
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
