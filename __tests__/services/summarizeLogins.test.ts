import { describe, test, expect } from '@jest/globals';
import { summarizeLogins } from '../../services/verdictAdapter.js';

describe('summarizeLogins (bead w1os.4)', () => {
  test('a skipped probe after a good sign-in is counted as not attempted, not failed', () => {
    expect(summarizeLogins([
      { source: 'explicit', submitted: true, authenticated: true },
      { reason: 'no_login_form_detected', submitted: false, authenticated: false },
    ])).toEqual({ total: 2, authenticated: 1, failed: 0, notAttempted: 1 });
  });
  test('typed-but-rejected counts as failed', () => {
    expect(summarizeLogins([{ submitted: true, authenticated: false }])).toEqual({ total: 1, authenticated: 0, failed: 1, notAttempted: 0 });
  });
  test('undefined stays undefined', () => expect(summarizeLogins(undefined)).toBeUndefined());
});
