import { describe, test, expect } from '@jest/globals';
import { summarizeLogins } from '../../services/verdictAdapter.js';

describe('summarizeLogins (bead w1os.4)', () => {
  test('a skipped probe after a good sign-in is counted as not attempted, not failed', () => {
    expect(summarizeLogins([
      { source: 'explicit', submitted: true, authenticated: true },
      { reason: 'no_login_form_detected', submitted: false, authenticated: false },
    ])).toEqual({ total: 2, authenticated: 1, failed: 0, notAttempted: 1, signedIn: true });
  });
  test('typed-but-rejected counts as failed', () => {
    expect(summarizeLogins([{ submitted: true, authenticated: false }])).toEqual({ total: 1, authenticated: 0, failed: 1, notAttempted: 0, signedIn: false });
  });
  test('a retry that authenticated after a rejected attempt reads signedIn', () => {
    const r = summarizeLogins([{ submitted: true, authenticated: false }, { submitted: true, authenticated: true }]);
    expect(r).toMatchObject({ failed: 1, authenticated: 1, signedIn: true });
  });
  test('a skipped record never counts as failed or signed in', () => {
    expect(summarizeLogins([{ skipped: true, submitted: true, authenticated: false }])).toEqual({ total: 1, authenticated: 0, failed: 0, notAttempted: 1, signedIn: false });
  });
  test('undefined stays undefined', () => expect(summarizeLogins(undefined)).toBeUndefined());
});
