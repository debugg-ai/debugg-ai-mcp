import { replaceTunnelUrls, generateTunnelUrl, retargetTunnelUrl, isLocalhostUrl, extractLocalhostPort, normalizeUrl } from '../../utils/urlParser.js';

describe('replaceTunnelUrls', () => {
  const origin = 'http://localhost:4001';

  test('replaces tunnel origin in a plain string, preserving path', () => {
    expect(replaceTunnelUrls('https://abc-123.tunnel.debugg.ai/dashboard', origin))
      .toBe('http://localhost:4001/dashboard');
  });

  test('preserves query string and hash after replacement', () => {
    expect(replaceTunnelUrls('https://abc.tunnel.debugg.ai/page?foo=bar#section', origin))
      .toBe('http://localhost:4001/page?foo=bar#section');
  });

  test('replaces multiple tunnel URLs in the same string', () => {
    const input = 'First: https://aaa.tunnel.debugg.ai/x, Second: https://bbb.tunnel.debugg.ai/y';
    expect(replaceTunnelUrls(input, origin))
      .toBe('First: http://localhost:4001/x, Second: http://localhost:4001/y');
  });

  test('leaves non-tunnel URLs unchanged', () => {
    expect(replaceTunnelUrls('https://example.com/page', origin)).toBe('https://example.com/page');
  });

  // The ngrok transport is gone, but a backend response about a HISTORICAL run
  // can still carry one of its hostnames, and an unrecognised tunnel hostname
  // leaks verbatim. See the box in utils/tunnelDomains.ts.
  test('still replaces a historical ngrok tunnel URL', () => {
    expect(replaceTunnelUrls('https://abc-123.ngrok.debugg.ai/dashboard', origin))
      .toBe('http://localhost:4001/dashboard');
  });

  test('replaces tunnel URLs in an object recursively', () => {
    const input = {
      finalUrl: 'https://abc-123.tunnel.debugg.ai/dashboard',
      agentResponse: 'Redirected to https://abc-123.tunnel.debugg.ai/dashboard successfully',
      stepsTaken: 5,
    };
    const result = replaceTunnelUrls(input, origin) as Record<string, any>;
    expect(result.finalUrl).toBe('http://localhost:4001/dashboard');
    expect(result.agentResponse).toBe('Redirected to http://localhost:4001/dashboard successfully');
    expect(result.stepsTaken).toBe(5);
  });

  test('replaces tunnel URLs in nested objects', () => {
    const input = { outer: { inner: { url: 'https://x.tunnel.debugg.ai/path' } } };
    const result = replaceTunnelUrls(input, origin) as any;
    expect(result.outer.inner.url).toBe('http://localhost:4001/path');
  });

  test('replaces tunnel URLs in arrays', () => {
    const input = ['https://a.tunnel.debugg.ai/one', 'https://b.tunnel.debugg.ai/two'];
    const result = replaceTunnelUrls(input, origin) as string[];
    expect(result[0]).toBe('http://localhost:4001/one');
    expect(result[1]).toBe('http://localhost:4001/two');
  });

  test('passes through null, numbers, and booleans unchanged', () => {
    expect(replaceTunnelUrls(null, origin)).toBeNull();
    expect(replaceTunnelUrls(42, origin)).toBe(42);
    expect(replaceTunnelUrls(true, origin)).toBe(true);
  });

  test('strips trailing slash from localhostOrigin before replacing', () => {
    expect(replaceTunnelUrls('https://abc.tunnel.debugg.ai/path', 'http://localhost:4001/'))
      .toBe('http://localhost:4001/path');
  });
});

describe('normalizeUrl', () => {
  test('passes through already-schemed URLs unchanged', () => {
    expect(normalizeUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeUrl('https://localhost:3000')).toBe('https://localhost:3000');
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
  });

  test('normalizes bare localhost:PORT', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeUrl('localhost:3000/path')).toBe('http://localhost:3000/path');
  });

  test('normalizes bare 127.0.0.1:PORT', () => {
    expect(normalizeUrl('127.0.0.1:1233')).toBe('http://127.0.0.1:1233');
  });

  test('normalizes bare 0.0.0.0:PORT', () => {
    expect(normalizeUrl('0.0.0.0:3000')).toBe('http://0.0.0.0:3000');
  });

  test('normalizes bare host.docker.internal:PORT', () => {
    expect(normalizeUrl('host.docker.internal:3000')).toBe('http://host.docker.internal:3000');
  });

  test('normalizes bare [::1]:PORT', () => {
    expect(normalizeUrl('[::1]:3000')).toBe('http://[::1]:3000');
  });

  test('passes through non-local bare strings unchanged', () => {
    expect(normalizeUrl('example.com')).toBe('example.com');
  });

  test('passes through non-string values unchanged', () => {
    expect(normalizeUrl(42)).toBe(42);
    expect(normalizeUrl(null)).toBeNull();
  });
});

describe('isLocalhostUrl — edge cases', () => {
  test('detects standard localhost', () => {
    expect(isLocalhostUrl('http://localhost:3000')).toBe(true);
    expect(isLocalhostUrl('https://localhost:3013')).toBe(true);
  });

  test('detects 127.0.0.1', () => {
    expect(isLocalhostUrl('http://127.0.0.1:1233')).toBe(true);
  });

  test('detects 0.0.0.0', () => {
    expect(isLocalhostUrl('http://0.0.0.0:3000')).toBe(true);
  });

  test('detects IPv6 localhost with brackets', () => {
    expect(isLocalhostUrl('http://[::1]:3000')).toBe(true);
  });

  test('detects host.docker.internal', () => {
    expect(isLocalhostUrl('http://host.docker.internal:3000')).toBe(true);
  });

  test('detects localhost with trailing dot', () => {
    expect(isLocalhostUrl('http://localhost.:3000')).toBe(true);
  });

  test('does not flag public URLs', () => {
    expect(isLocalhostUrl('https://example.com')).toBe(false);
    expect(isLocalhostUrl('https://my-app.vercel.app')).toBe(false);
  });
});

describe('generateTunnelUrl / extractLocalhostPort', () => {
  // The tunnel domain is a REQUIRED argument. It used to default to
  // 'ngrok.debugg.ai', which is how a caller that forgot to pass the
  // provision's domain silently minted a hostname on the wrong domain
  // (design §5's "generateTunnelUrl already takes a domain parameter, so its
  // caller is the bug"). There is no default to be wrong about now.
  test('generateTunnelUrl produces correct URL', () => {
    expect(generateTunnelUrl('http://localhost:3000/app', 'my-tunnel-id', 'tunnel.debugg.ai'))
      .toBe('https://my-tunnel-id.tunnel.debugg.ai/app');
  });

  test('generateTunnelUrl works for 0.0.0.0', () => {
    expect(generateTunnelUrl('http://0.0.0.0:3000/app', 'my-tunnel-id', 'tunnel.debugg.ai'))
      .toBe('https://my-tunnel-id.tunnel.debugg.ai/app');
  });

  // Bead zmc9: reuse composes the reused tunnel's ORIGIN with the CURRENT request's path.
  describe('retargetTunnelUrl', () => {
    const ORIGIN = 'https://abc123.tunnel.debugg.ai';

    test('uses the caller path, discarding any path baked into publicUrl', () => {
      // ORIGIN here is the path-free tunnelUrl; the creator path is irrelevant.
      expect(retargetTunnelUrl(ORIGIN, 'http://localhost:3011/dashboard'))
        .toBe('https://abc123.tunnel.debugg.ai/dashboard');
    });

    test('root-path caller gets the bare root (the exact zmc9 repro)', () => {
      expect(retargetTunnelUrl(ORIGIN, 'http://localhost:3011/'))
        .toBe('https://abc123.tunnel.debugg.ai/');
    });

    test('preserves search and hash', () => {
      expect(retargetTunnelUrl(ORIGIN, 'http://localhost:3011/p?q=1&x=2#frag'))
        .toBe('https://abc123.tunnel.debugg.ai/p?q=1&x=2#frag');
    });

    test('a stale origin that itself carries a path is stripped to origin + caller path', () => {
      // Defensive: even if handed a path-bearing string, only its origin is used.
      expect(retargetTunnelUrl('https://abc123.tunnel.debugg.ai/OLD/creator/path', 'http://localhost:3011/new'))
        .toBe('https://abc123.tunnel.debugg.ai/new');
    });

    test('invalid tunnel origin falls back to the origin string, never a foreign path', () => {
      expect(retargetTunnelUrl('not-a-url', 'http://localhost:3011/x')).toBe('not-a-url');
    });
  });

  test('extractLocalhostPort extracts port', () => {
    expect(extractLocalhostPort('http://localhost:4001')).toBe(4001);
    expect(extractLocalhostPort('http://0.0.0.0:8080')).toBe(8080);
    expect(extractLocalhostPort('http://[::1]:3000')).toBe(3000);
    expect(extractLocalhostPort('https://example.com')).toBeUndefined();
  });

  test('extractLocalhostPort falls back to protocol default when no port', () => {
    expect(extractLocalhostPort('http://localhost')).toBe(80);
    expect(extractLocalhostPort('https://localhost')).toBe(443);
  });
});

describe('private IP ranges', () => {
  test.each([
    ['http://192.168.1.1:3000', true],
    ['http://192.168.0.1', true],
    ['http://10.0.0.1:8080', true],
    ['http://10.255.255.255', true],
    ['http://172.16.0.1', true],
    ['http://172.31.255.255', true],
    ['http://172.32.0.1', false],  // outside range
    ['http://8.8.8.8', false],
  ])('%s isLocalhost=%s', (url, expected) => {
    expect(isLocalhostUrl(url)).toBe(expected);
  });
});

describe('generateTunnelUrl edge cases', () => {
  test('returns original URL unchanged when URL fails to parse', () => {
    const badUrl = 'not-a-valid-url';
    expect(generateTunnelUrl(badUrl, 'tunnel-id')).toBe(badUrl);
  });

  test('returns original URL unchanged when URL is not localhost', () => {
    expect(generateTunnelUrl('https://example.com/path', 'tunnel-id')).toBe('https://example.com/path');
  });
});

describe('extractLocalhostPort defaults', () => {
  test('http://localhost (no port) returns 80', () => {
    expect(extractLocalhostPort('http://localhost')).toBe(80);
  });

  test('https://localhost (no port) returns 443', () => {
    expect(extractLocalhostPort('https://localhost')).toBe(443);
  });
});
