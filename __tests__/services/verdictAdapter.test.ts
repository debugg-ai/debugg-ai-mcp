/**
 * verdictAdapter tests (bead 56kd.2).
 *
 * The adapter is the ONE place that maps the backend explicit-verdict + budget
 * + evidence contract onto the MCP relay fields. Principle: relay, never
 * invent. It must NOT fabricate a failure or an assertion-mismatch from thin
 * state — a missing/unknown verdict surfaces as `error`, not `fail`.
 *
 * The user-facing enum is pass | fail | error (platform-98fv.16). The
 * three-outcome mapping itself, and the factual reason text, are covered in
 * verdictAdapter.threeOutcomes.test.ts; what this file still guards is
 * PRECEDENCE and the never-invent rules, which are unchanged.
 *
 * Backend contract (camelCase after axiosTransport conversion). The containers
 * are TOP-LEVEL siblings of `state` on the execution-detail response:
 *   execution.verdict:  { outcome: pass|fail|inconclusive|error|timeout, reason }
 *   execution.budget:   { maxSteps, usedSteps }
 *   execution.evidence: { screenshot, actionTrace }
 * `verdict` is SINGULAR — NOT the plural `verdicts` array nor the raw `outcome`
 * string that also live on the response.
 */

import type { WorkflowExecution } from '../../services/workflows.js';
import { adaptVerdict } from '../../services/verdictAdapter.js';
import type { LoginRecord } from '../../services/verdictAdapter.js';

function makeExecution(fields: Partial<WorkflowExecution> = {}): WorkflowExecution {
  return {
    uuid: 'exec-1',
    status: 'completed',
    startedAt: null,
    completedAt: null,
    durationMs: null,
    state: null,
    errorMessage: '',
    errorInfo: null,
    nodeExecutions: [],
    ...fields,
  };
}

describe('adaptVerdict — explicit verdict relay', () => {
  test('verdict.outcome "pass" → outcome verbatim, nothing derived beside it', () => {
    const exec = makeExecution({ verdict: { outcome: 'pass', reason: 'looks good' } });
    const v = adaptVerdict(exec);
    expect(v.outcome).toBe('pass');
    expect(v.reason).toBe('looks good');
    // a second copy of the verdict is a second thing to disagree with it
    expect(v).not.toHaveProperty('success');
    expect(v).not.toHaveProperty('failureCategory');
  });

  test('verdict.outcome "fail" → verbatim', () => {
    const v = adaptVerdict(makeExecution({ verdict: { outcome: 'fail' } }));
    expect(v.outcome).toBe('fail');
  });

  test.each(['inconclusive', 'error', 'timeout'])(
    'verdict.outcome "%s" → error',
    (outcome) => {
      const v = adaptVerdict(makeExecution({ verdict: { outcome } }));
      expect(v.outcome).toBe('error');
    },
  );

  test('thin state (no verdict, no outcome) → error, NOT fail', () => {
    const v = adaptVerdict(makeExecution({ state: { outcome: '', success: false, stepsTaken: 0, error: '' } }));
    expect(v.outcome).toBe('error');
  });

  test('null state and no verdict → error (never throws)', () => {
    const v = adaptVerdict(makeExecution({ state: null }));
    expect(v.outcome).toBe('error');
  });

  test('unknown/garbage verdict.outcome → error (not relayed verbatim)', () => {
    const v = adaptVerdict(makeExecution({ verdict: { outcome: 'totally-made-up' } }));
    expect(v.outcome).toBe('error');
  });

  test('never falls back to the raw execution status as an outcome', () => {
    // Old bug: outcome = state?.outcome ?? execution.status → "failed"/"completed"
    // leaked into the outcome field. A failed status with no verdict must be
    // inconclusive, not "failed".
    const v = adaptVerdict(makeExecution({ state: null, status: 'failed' }));
    expect(v.outcome).toBe('error');
    expect(v.outcome).not.toBe('failed');
  });

  test('the raw state.outcome is never read as the verdict (platform-98fv.16)', () => {
    // It is the run's internal record and can be cancelled / timeout / skipped.
    const v = adaptVerdict(makeExecution({ state: { outcome: 'fail', success: false, stepsTaken: 2, error: 'x' } }));
    expect(v.outcome).toBe('error');
  });

  test('top-level verdict wins over legacy state.outcome', () => {
    const v = adaptVerdict(makeExecution({
      verdict: { outcome: 'pass' },
      state: { outcome: 'fail', success: false, stepsTaken: 1, error: '' },
    }));
    expect(v.outcome).toBe('pass');
  });

  test('outcomeOverride wins (used by the timeout path)', () => {
    const exec = makeExecution({ verdict: { outcome: 'pass' } });
    const v = adaptVerdict(exec, { outcomeOverride: 'timeout' });
    // 'timeout' is ours and maps to error; what matters here is that the
    // override BEAT the backend's 'pass' rather than being ignored.
    expect(v.outcome).toBe('error');
  });
});

describe('adaptVerdict — budget relayed as the backend sent it', () => {
  test('the backend budget container is relayed verbatim, under its own field names', () => {
    const exec = makeExecution({ verdict: { outcome: 'pass' }, budget: { maxSteps: 40, usedSteps: 12 } });
    const v = adaptVerdict(exec);
    expect(v.budget).toEqual({ maxSteps: 40, usedSteps: 12 });
    // no renamed / derived copies
    expect(v).not.toHaveProperty('stepsBudget');
    expect(v).not.toHaveProperty('stepsTaken');
    expect(v).not.toHaveProperty('stepsRemaining');
  });

  test('no budget in the response → no budget in the relay (none invented)', () => {
    const exec = makeExecution({ verdict: { outcome: 'pass' }, state: { outcome: 'pass', success: true, stepsTaken: 3, error: '' } });
    const v = adaptVerdict(exec);
    expect(v).not.toHaveProperty('budget');
  });
});

describe('adaptVerdict — evidence relay', () => {
  test('evidence.screenshot / actionTrace passed through', () => {
    const trace = [{ step: 1, action: 'click' }];
    const exec = makeExecution({ verdict: { outcome: 'fail' }, evidence: { screenshot: 'data:image/png;base64,AAA', actionTrace: trace } });
    const v = adaptVerdict(exec);
    expect(v.screenshot).toBe('data:image/png;base64,AAA');
    expect(v.actionTrace).toEqual(trace);
  });

  test('no evidence → screenshot/actionTrace undefined (handler falls back to node extraction)', () => {
    const v = adaptVerdict(makeExecution({ verdict: { outcome: 'pass' } }));
    expect(v.screenshot).toBeUndefined();
    expect(v.actionTrace).toBeUndefined();
  });
});

// bead ymq2: callers read logins[] as the single most useful part of the
// response. These pin the relay, typed against LoginRecord so the declared
// contract and the runtime relay are held together: a refactor that maps the
// array field-by-field, or drops a field from the interface, breaks one of them.
describe('adaptVerdict — logins relay', () => {
  const OFFSCOPE_DETAIL =
    "refused to enter credentials on auth.idp.example: not part of this run's scope (app.example.com). " +
    "If auth.idp.example is your identity provider, add it to the environment's authorized credential hosts";

  test('an offscope refusal keeps its actionable detail', () => {
    const logins: LoginRecord[] = [
      { username: 'qa@example.com', source: 'env_default', submitted: false, authenticated: false, reason: 'offscope_host', detail: OFFSCOPE_DETAIL },
    ];
    const v = adaptVerdict(makeExecution({ verdict: { outcome: 'fail' }, evidence: { logins } }));
    const first: LoginRecord | undefined = v.logins?.[0];
    expect(first?.reason).toBe('offscope_host');
    expect(first?.detail).toBe(OFFSCOPE_DETAIL);
  });

  test('source / submitted / authenticated / reason all survive the relay', () => {
    const logins: LoginRecord[] = [
      { username: 'a@example.com', source: 'task', submitted: true, authenticated: true, reason: 'logged_in' },
      { username: 'b@example.com', source: 'env_default', submitted: false, authenticated: false, reason: 'offscope_host', detail: 'why' },
      { username: 'c@example.com', source: 'credential_id', submitted: false, authenticated: true, reason: 'restored_session' },
    ];
    const v = adaptVerdict(makeExecution({ verdict: { outcome: 'pass' }, evidence: { logins } }));

    expect(v.logins).toHaveLength(3);
    v.logins!.forEach((got: LoginRecord, i: number) => {
      const want = logins[i];
      expect(got.username).toBe(want.username);
      expect(got.source).toBe(want.source);
      expect(got.submitted).toBe(want.submitted);
      expect(got.authenticated).toBe(want.authenticated);
      expect(got.reason).toBe(want.reason);
      expect(got.detail).toBe(want.detail);
    });
  });

  test('an empty logins array is omitted, not relayed as []', () => {
    const v = adaptVerdict(makeExecution({ verdict: { outcome: 'pass' }, evidence: { logins: [] } }));
    expect(v.logins).toBeUndefined();
  });
});
