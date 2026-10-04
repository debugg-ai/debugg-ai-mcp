/**
 * A goal that names localhost must not reach the REMOTE browser saying
 * "localhost".
 *
 * Root cause (platform-98fv.16): 15 of 431 judged prod runs in 30 days failed
 * because our own goal text said "go to http://localhost:3017" while the target
 * was the tunnel. The remote browser dialled ITS own loopback, got connection
 * refused, and the run was recorded as the app failing. The tunnel was fine
 * every time — we told the browser to go to the wrong machine.
 *
 * The URL and the auth URLs were already rewritten; the goal text was passed
 * verbatim, which made the omission look deliberate rather than missed.
 */
import { describe, expect, test } from '@jest/globals';
import { rewriteLocalhostInText } from '../../utils/urlParser.js';

const TUNNEL = 'https://abc123.tunnel.debugg.ai';

describe('rewriting localhost inside free text', () => {
  test.each([
    ['go to http://localhost:3017 and click save', 'http://localhost:3017'],
    ['open http://127.0.0.1:3017/dashboard', 'http://127.0.0.1:3017'],
    ['visit https://localhost:8443/admin then log in', 'https://localhost:8443'],
  ])('rewrites %s', (text, origin) => {
    const out = rewriteLocalhostInText(text, TUNNEL);
    expect(out).not.toContain('localhost');
    expect(out).not.toContain('127.0.0.1');
    expect(out).toContain('abc123.tunnel.debugg.ai');
    void origin;
  });

  test('keeps the path, query and fragment — the goal often depends on them', () => {
    const out = rewriteLocalhostInText('check http://localhost:3017/app?tab=2#row5 renders', TUNNEL);
    expect(out).toBe(`check ${TUNNEL}/app?tab=2#row5 renders`);
  });

  test('rewrites every occurrence, not just the first', () => {
    const out = rewriteLocalhostInText('from http://localhost:3017/a to http://localhost:3017/b', TUNNEL);
    expect(out).toBe(`from ${TUNNEL}/a to ${TUNNEL}/b`);
  });

  test('leaves text with no localhost completely untouched', () => {
    const text = 'click the Save button and confirm the toast says Saved';
    expect(rewriteLocalhostInText(text, TUNNEL)).toBe(text);
  });

  test('does not maul a bare word that merely contains "localhost"', () => {
    const text = 'the localhostname field should be empty';
    expect(rewriteLocalhostInText(text, TUNNEL)).toBe(text);
  });

  test('no tunnel URL means no rewrite — never invent a destination', () => {
    const text = 'go to http://localhost:3017';
    expect(rewriteLocalhostInText(text, undefined)).toBe(text);
    expect(rewriteLocalhostInText(text, '')).toBe(text);
  });

  test('empty or missing text is returned as given', () => {
    expect(rewriteLocalhostInText('', TUNNEL)).toBe('');
    expect(rewriteLocalhostInText(undefined, TUNNEL)).toBeUndefined();
  });
});
