/**
 * Every verdict a user sees is pass | fail | error. Nothing else.
 *
 * Contract agreed with the backend workstream (platform-98fv.16, 2026-10-04):
 *   pass  = the run's own machine checks matched
 *   fail  = the app did not do what was asked (includes target unreachable)
 *   error = we could not test, and the reason says why in plain words
 *
 * "inconclusive" / "unverified" / "unknown" / "abandoned" are gone as
 * user-facing values. They were a verdict that told a user nothing they could
 * act on.
 *
 * `timeout` is the subtle one and it is NOT the backend's. The MCP invents it
 * when its own poll deadline expires (services/workflows.ts), which is a
 * completely different event from the backend reporting that a run timed out:
 * one means we stopped listening, the other means the run stopped. Both become
 * `error`, because neither is a verdict about the app — but the reasons must
 * stay distinguishable.
 *
 * Reasons are FACTUAL RECORDS (Quinn, 2026-10-04): what we did, what we saw,
 * what happened. No hedges, no blame, no advice, and no fixed sentence per
 * category — so these tests assert that real observed values appear, and that
 * no canned phrasing creeps back in.
 */
import { describe, expect, test } from '@jest/globals';
import { adaptVerdict, USER_FACING_OUTCOMES } from '../../services/verdictAdapter.js';

const makeExecution = (over: any = {}): any => ({
  uuid: 'e1', status: 'completed', state: { outcome: '', success: false, stepsTaken: 0, error: '' }, ...over,
});

describe('the user-facing verdict enum', () => {
  test('is exactly pass | fail | error', () => {
    expect([...USER_FACING_OUTCOMES].sort()).toEqual(['error', 'fail', 'pass']);
  });

  test.each(['inconclusive', 'unverified', 'unknown', 'abandoned', 'wat'])(
    '%s is never emitted — it becomes error, and the reason NAMES what arrived',
    (raw) => {
      const v = adaptVerdict(makeExecution({ verdict: { outcome: raw } }));
      expect(v.outcome).toBe('error');
      expect(v.success).toBe(false);
      // the actual value is reported, so two occurrences are distinguishable
      expect(v.reason).toBe(`Backend returned outcome '${raw}' with no reason.`);
    },
  );

  test('a missing verdict becomes error, not a silent pass and not fail', () => {
    const v = adaptVerdict(makeExecution({ state: null }));
    expect(v.outcome).toBe('error');
    expect(v.reason).toBe('Backend returned no outcome and no reason.');
  });

  test('pass and fail are untouched, and a backend reason survives', () => {
    expect(adaptVerdict(makeExecution({ verdict: { outcome: 'pass', reason: 'looks good' } })).outcome).toBe('pass');
    const f = adaptVerdict(makeExecution({ verdict: { outcome: 'fail', reason: 'the button did nothing' } }));
    expect(f.outcome).toBe('fail');
    expect(f.reason).toBe('the button did nothing');
  });

  test("the backend's own error reason is shown, never replaced", () => {
    const v = adaptVerdict(makeExecution({
      verdict: { outcome: 'error', reason: 'The login you gave us was refused.' },
    }));
    expect(v.outcome).toBe('error');
    expect(v.reason).toBe('The login you gave us was refused.');
  });
});

describe('timeout: who gave up matters', () => {
  test('OUR poll deadline reports the facts it observed, with real numbers', () => {
    const v = adaptVerdict(makeExecution({ uuid: 'exec-abc', status: 'running' }), {
      outcomeOverride: 'timeout',
      pollTimeout: { elapsedMs: 600_000, pollCount: 42 },
    });
    expect(v.outcome).toBe('error');
    expect(v.reason).toContain('exec-abc');
    expect(v.reason).toContain('600s');
    expect(v.reason).toContain('42 polls');
    expect(v.reason).toContain('running');
  });

  test('no hedging, no advice, no blame in a reason we write ourselves', () => {
    const v = adaptVerdict(makeExecution({ uuid: 'exec-abc', status: 'running' }), {
      outcomeOverride: 'timeout',
      pollTimeout: { elapsedMs: 600_000 },
    });
    expect(v.reason).not.toMatch(/\bmay\b|\blikely\b|\bprobably\b|\bmight\b/i);
    expect(v.reason).not.toMatch(/\btry\b|\bcheck\b|\bshould\b|\bmake sure\b/i);
  });

  test("a BACKEND-reported timeout keeps the backend's own reason", () => {
    const v = adaptVerdict(makeExecution({
      verdict: { outcome: 'timeout', reason: 'The run exceeded its step budget.' },
    }));
    expect(v.outcome).toBe('error');
    expect(v.reason).toBe('The run exceeded its step budget.');
    // and must NOT be overwritten with our own poll-deadline record
    expect(v.reason).not.toMatch(/polling|polls/i);
  });

  test('our deadline BEATS a stale backend reason we happen to be holding', () => {
    // The nasty case: we gave up polling while holding a reason from a
    // mid-flight poll. That reason describes a run still in progress, so
    // relaying it would pair outcome='error' with someone else's "looks good".
    const v = adaptVerdict(
      makeExecution({ uuid: 'exec-abc', status: 'running', verdict: { outcome: 'pass', reason: 'looks good' } }),
      { outcomeOverride: 'timeout', pollTimeout: { elapsedMs: 600_000, pollCount: 37 } },
    );
    expect(v.outcome).toBe('error');
    expect(v.reason).not.toBe('looks good');
    expect(v.reason).toContain('600s of polling');
  });

  test('the two timeout cases are distinguishable from the reason alone', () => {
    const ours = adaptVerdict(makeExecution({ uuid: 'exec-abc' }), {
      outcomeOverride: 'timeout', pollTimeout: { elapsedMs: 600_000 },
    }).reason;
    const theirs = adaptVerdict(makeExecution({
      verdict: { outcome: 'timeout', reason: 'The run exceeded its step budget.' },
    })).reason;
    expect(ours).not.toEqual(theirs);
  });
});
