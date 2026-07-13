/**
 * verdictAdapter tests (bead 56kd.2).
 *
 * The adapter is the ONE place that maps the backend explicit-verdict + budget
 * + evidence contract onto the MCP relay fields. Principle: relay, never
 * invent. It must NOT fabricate a failure or an assertion-mismatch from thin
 * state — a missing/unknown verdict surfaces as `inconclusive`, not `fail`.
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
  test('verdict.outcome "pass" → outcome verbatim, success true, no failureCategory', () => {
    const exec = makeExecution({ verdict: { outcome: 'pass', reason: 'looks good' } });
    const v = adaptVerdict(exec);
    expect(v.outcome).toBe('pass');
    expect(v.success).toBe(true);
    expect(v.failureCategory).toBeUndefined();
    expect(v.reason).toBe('looks good');
  });

  test.each(['fail', 'inconclusive', 'error', 'timeout'])(
    'verdict.outcome "%s" → verbatim, success false, failureCategory = outcome',
    (outcome) => {
      const exec = makeExecution({ verdict: { outcome } });
      const v = adaptVerdict(exec);
      expect(v.outcome).toBe(outcome);
      expect(v.success).toBe(false);
      expect(v.failureCategory).toBe(outcome); // NOT a fabricated 'assertion-mismatch'
    },
  );

  test('thin state (no verdict, no outcome) → inconclusive, NOT fail', () => {
    const v = adaptVerdict(makeExecution({ state: { outcome: '', success: false, stepsTaken: 0, error: '' } }));
    expect(v.outcome).toBe('inconclusive');
    expect(v.success).toBe(false);
    expect(v.failureCategory).toBe('inconclusive');
  });

  test('null state and no verdict → inconclusive (never throws)', () => {
    const v = adaptVerdict(makeExecution({ state: null }));
    expect(v.outcome).toBe('inconclusive');
    expect(v.success).toBe(false);
  });

  test('unknown/garbage verdict.outcome → inconclusive (not relayed verbatim)', () => {
    const v = adaptVerdict(makeExecution({ verdict: { outcome: 'totally-made-up' } }));
    expect(v.outcome).toBe('inconclusive');
  });

  test('never falls back to the raw execution status as an outcome', () => {
    // Old bug: outcome = state?.outcome ?? execution.status → "failed"/"completed"
    // leaked into the outcome field. A failed status with no verdict must be
    // inconclusive, not "failed".
    const v = adaptVerdict(makeExecution({ state: null, status: 'failed' }));
    expect(v.outcome).toBe('inconclusive');
    expect(v.outcome).not.toBe('failed');
  });

  test('legacy state.outcome (defensive fallback) still relayed when it is a known verdict', () => {
    const v = adaptVerdict(makeExecution({ state: { outcome: 'fail', success: false, stepsTaken: 2, error: 'x' } }));
    expect(v.outcome).toBe('fail');
    expect(v.failureCategory).toBe('fail');
  });

  test('top-level verdict wins over legacy state.outcome', () => {
    const v = adaptVerdict(makeExecution({
      verdict: { outcome: 'pass' },
      state: { outcome: 'fail', success: false, stepsTaken: 1, error: '' },
    }));
    expect(v.outcome).toBe('pass');
    expect(v.success).toBe(true);
  });

  test('outcomeOverride wins (used by the timeout path)', () => {
    const exec = makeExecution({ verdict: { outcome: 'pass' } });
    const v = adaptVerdict(exec, { outcomeOverride: 'timeout' });
    expect(v.outcome).toBe('timeout');
    expect(v.success).toBe(false);
    expect(v.failureCategory).toBe('timeout');
  });
});

describe('adaptVerdict — budget sourced from the response', () => {
  test('budget.maxSteps / usedSteps drive stepsBudget / stepsTaken / stepsRemaining', () => {
    const exec = makeExecution({ verdict: { outcome: 'pass' }, budget: { maxSteps: 40, usedSteps: 12 } });
    const v = adaptVerdict(exec, { fallbackBudget: 25 });
    expect(v.stepsBudget).toBe(40); // from response, NOT the 25 fallback
    expect(v.stepsTaken).toBe(12);
    expect(v.stepsRemaining).toBe(28);
  });

  test('no budget in response → falls back to the provided client constant', () => {
    const exec = makeExecution({ verdict: { outcome: 'pass' }, state: { outcome: 'pass', success: true, stepsTaken: 3, error: '' } });
    const v = adaptVerdict(exec, { fallbackBudget: 25 });
    expect(v.stepsBudget).toBe(25);
    expect(v.stepsTaken).toBe(3); // legacy state.stepsTaken
    expect(v.stepsRemaining).toBe(22);
  });

  test('stepsRemaining clamps at 0 (agent ran past budget)', () => {
    const exec = makeExecution({ budget: { maxSteps: 25, usedSteps: 30 }, verdict: { outcome: 'pass' } });
    const v = adaptVerdict(exec);
    expect(v.stepsRemaining).toBe(0);
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
