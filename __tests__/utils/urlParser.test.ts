import { replaceTunnelUrls, generateTunnelUrl, isLocalhostUrl, extractLocalhostPort, normalizeUrl } from '../../utils/urlParser.js';

describe('replaceTunnelUrls', () => {
  const origin = 'http://localhost:4001';

  test('replaces tunnel origin in a plain string, preserving path', () => {
    expect(replaceTunnelUrls('https://abc-123.ngrok.debugg.ai/dashboard', origin))
      .toBe('http://localhost:4001/dashboard');
  });

  test('preserves query string and hash after replacement', () => {
    expect(replaceTunnelUrls('https://abc.ngrok.debugg.ai/page?foo=bar#section', origin))
      .toBe('http://localhost:4001/page?foo=bar#section');
  });

  test('replaces multiple tunnel URLs in the same string', () => {
    const input = 'First: https://aaa.ngrok.debugg.ai/x, Second: https://bbb.ngrok.debugg.ai/y';
    expect(replaceTunnelUrls(input, origin))
      .toBe('First: http://localhost:4001/x, Second: http://localhost:4001/y');
  });

  test('leaves non-tunnel URLs unchanged', () => {
    expect(replaceTunnelUrls('https://example.com/page', origin)).toBe('https://example.com/page');
  });

  test('replaces tunnel URLs in an object recursively', () => {
    const input = {
      finalUrl: 'https://abc-123.ngrok.debugg.ai/dashboard',
      agentResponse: 'Redirected to https://abc-123.ngrok.debugg.ai/dashboard successfully',
      stepsTaken: 5,
    };
    const result = replaceTunnelUrls(input, origin) as Record<string, any>;
    expect(result.finalUrl).toBe('http://localhost:4001/dashboard');
    expect(result.agentResponse).toBe('Redirected to http://localhost:4001/dashboard successfully');
    expect(result.stepsTaken).toBe(5);
  });

  test('replaces tunnel URLs in nested objects', () => {
    const input = { outer: { inner: { url: 'https://x.ngrok.debugg.ai/path' } } };
    const result = replaceTunnelUrls(input, origin) as any;
    expect(result.outer.inner.url).toBe('http://localhost:4001/path');
  });

  test('replaces tunnel URLs in arrays', () => {
    const input = ['https://a.ngrok.debugg.ai/one', 'https://b.ngrok.debugg.ai/two'];
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
    expect(replaceTunnelUrls('https://abc.ngrok.debugg.ai/path', 'http://localhost:4001/'))
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
  test('generateTunnelUrl produces correct URL', () => {
    expect(generateTunnelUrl('http://localhost:3000/app', 'my-tunnel-id'))
      .toBe('https://my-tunnel-id.ngrok.debugg.ai/app');
  });

  test('generateTunnelUrl works for 0.0.0.0', () => {
    expect(generateTunnelUrl('http://0.0.0.0:3000/app', 'my-tunnel-id'))
      .toBe('https://my-tunnel-id.ngrok.debugg.ai/app');
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
