import { replaceTunnelUrls, generateTunnelUrl, isLocalhostUrl, extractLocalhostPort } from '../../utils/urlParser.js';

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

describe('generateTunnelUrl / isLocalhostUrl / extractLocalhostPort (existing)', () => {
  test('generateTunnelUrl produces correct URL', () => {
    expect(generateTunnelUrl('http://localhost:3000/app', 'my-tunnel-id'))
      .toBe('https://my-tunnel-id.ngrok.debugg.ai/app');
  });

  test('isLocalhostUrl detects localhost correctly', () => {
    expect(isLocalhostUrl('http://localhost:3000')).toBe(true);
    expect(isLocalhostUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isLocalhostUrl('https://example.com')).toBe(false);
  });

  test('extractLocalhostPort extracts port', () => {
    expect(extractLocalhostPort('http://localhost:4001')).toBe(4001);
    expect(extractLocalhostPort('https://example.com')).toBeUndefined();
  });
});
