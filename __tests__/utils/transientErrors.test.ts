/**
 * isTransientWorkflowError — pattern detection tests.
 *
 * Recognized transient signatures matter because they decide whether the
 * MCP layer auto-retries (cost: another quota unit) or surfaces the error
 * straight to the caller. Be conservative — only well-documented transient
 * signatures. False positives waste quota; false negatives leave existing
 * behavior (which is fine — caller still gets a clear error).
 */

import { isTransientWorkflowError } from '../../utils/transientErrors.js';

function exec(opts: { errorMessage?: string; stateError?: string; status?: string } = {}) {
  return {
    uuid: 'exec-1',
    status: opts.status ?? 'completed',
    startedAt: null,
    completedAt: null,
    durationMs: null,
    state: {
      outcome: 'fail',
      success: false,
      stepsTaken: 0,
      error: opts.stateError ?? '',
    },
    errorMessage: opts.errorMessage ?? '',
    errorInfo: null,
    nodeExecutions: [],
  } as any;
}

describe('isTransientWorkflowError', () => {
  describe('pattern matches → returns true', () => {
    test('Pydantic JSON parse error (the original client complaint)', () => {
      expect(isTransientWorkflowError(exec({
        stateError: 'Invalid JSON: EOF while parsing a value at line 1 column 0',
      }))).toBe(true);
    });

    test('AgentOutput parse error (variation)', () => {
      expect(isTransientWorkflowError(exec({
        stateError: 'Failed to parse AgentOutput response from model',
      }))).toBe(true);
    });

    test('502 Bad Gateway from backend nginx', () => {
      expect(isTransientWorkflowError(exec({
        errorMessage: '<html><head><title>502 Bad Gateway</title></head>',
      }))).toBe(true);
    });

    test('upstream timeout', () => {
      expect(isTransientWorkflowError(exec({
        errorMessage: 'upstream connect timeout exceeded',
      }))).toBe(true);
    });

    test('connection reset by peer (network blip mid-execution)', () => {
      expect(isTransientWorkflowError(exec({
        stateError: 'ECONNRESET: connection reset by peer',
      }))).toBe(true);
    });

    test('matches in errorMessage even when state.error empty', () => {
      expect(isTransientWorkflowError(exec({
        errorMessage: 'Invalid JSON: EOF while parsing',
        stateError: '',
      }))).toBe(true);
    });

    test('matches in state.error even when errorMessage empty', () => {
      expect(isTransientWorkflowError(exec({
        errorMessage: '',
        stateError: 'Invalid JSON: EOF while parsing',
      }))).toBe(true);
    });
  });

  describe('non-transient errors → returns false (no retry)', () => {
    test('successful execution: no error to retry on', () => {
      const e = exec();
      e.state.success = true;
      e.state.outcome = 'pass';
      expect(isTransientWorkflowError(e)).toBe(false);
    });

    test('assertion mismatch: page didn\'t match expectations — retry won\'t help', () => {
      expect(isTransientWorkflowError(exec({
        stateError: 'Assertion failed: expected heading to contain "Welcome"',
      }))).toBe(false);
    });

    test('explicit auth failure: retry would just hit same 401', () => {
      expect(isTransientWorkflowError(exec({
        errorMessage: '401 Unauthorized: invalid API key',
      }))).toBe(false);
    });

    test('quota exceeded: retry would just hit same quota error', () => {
      expect(isTransientWorkflowError(exec({
        errorMessage: 'Quota exceeded for workflow_executions: 1001/1000',
      }))).toBe(false);
    });

    test('NotFound: retry won\'t make a missing template appear', () => {
      expect(isTransientWorkflowError(exec({
        errorMessage: 'No workflow template matching "page probe" found',
      }))).toBe(false);
    });

    test('empty error fields: no signal to retry on', () => {
      expect(isTransientWorkflowError(exec())).toBe(false);
    });
  });

  describe('null/edge cases', () => {
    test('null state object: false (no signal)', () => {
      const e = exec();
      e.state = null;
      expect(isTransientWorkflowError(e)).toBe(false);
    });

    test('null execution argument: false (defensive)', () => {
      expect(isTransientWorkflowError(null as any)).toBe(false);
    });

    test('undefined argument: false (defensive)', () => {
      expect(isTransientWorkflowError(undefined as any)).toBe(false);
    });
  });
});
