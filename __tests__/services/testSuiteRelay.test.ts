/**
 * test_suite results relay what the backend reported — no invented status or
 * counts, and per-test outcomes on the same pass | fail | error allowlist as
 * every other user-facing verdict.
 */

import { describe, expect, test } from '@jest/globals';
import { DebuggAIServerClient } from '../../services/index.js';

function clientReturning(body: unknown, method: 'get' | 'post' = 'get') {
  const client = new DebuggAIServerClient('k');
  (client as any).tx = { [method]: async () => body };
  return client;
}

describe('getTestSuiteDetail', () => {
  test('a field the backend did not send is null, not NEVER_RUN / 0', async () => {
    const detail = await clientReturning({ uuid: 's', name: 'S', tests: [{ uuid: 't', name: 'T' }] })
      .getTestSuiteDetail('s');
    expect(detail.runStatus).toBeNull();
    expect(detail.tests[0].runCount).toBeNull();
    expect(detail.tests[0].passedRunsCount).toBeNull();
    expect(detail.tests[0].failedRunsCount).toBeNull();
  });

  test('per-test outcomes use the user-facing allowlist; a pending run keeps null', async () => {
    const detail = await clientReturning({
      uuid: 's', name: 'S', runStatus: 'COMPLETED',
      tests: [
        { uuid: 'a', name: 'A', curRun: { uuid: 'r1', status: 'completed', outcome: 'unknown', timestamp: 't' } },
        { uuid: 'b', name: 'B', curRun: { uuid: 'r2', status: 'completed', outcome: 'fail', timestamp: 't' } },
        { uuid: 'c', name: 'C', curRun: { uuid: 'r3', status: 'pending', outcome: null, timestamp: 't' } },
      ],
    }).getTestSuiteDetail('s');
    expect(detail.tests.map((t) => t.lastRun?.outcome)).toEqual(['error', 'fail', null]);
  });
});

describe('runTestSuite', () => {
  test('a missing runStatus is null, not an invented PENDING', async () => {
    const r = await clientReturning({ tests: [] }, 'post').runTestSuite('s', {});
    expect(r.runStatus).toBeNull();
  });
});
