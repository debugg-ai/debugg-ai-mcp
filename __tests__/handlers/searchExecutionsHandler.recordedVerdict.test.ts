/**
 * platform-4cvj.78: the executions lookup shows the run's RECORDED verdict
 * everywhere it shows an outcome — including inside `state`.
 *
 * Prod 8511c14d / 798e80e2: never signed in, so the verdict is error ("We did not
 * get signed in ... so this run has no result"). The backend keeps the agent's own
 * claim in state.outcome ('pass', success true) by design (platform-98fv.16) and
 * stamps the verdict beside it. The uuid detail relayed state raw, so a caller read
 * status=completed + state.outcome=pass + success=true: a guest run that "passed".
 */
import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockGetExecution = jest.fn<(uuid: string) => Promise<any>>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    workflows: { getExecution: mockGetExecution, listExecutions: jest.fn() },
  })),
}));

const { searchExecutionsHandler } = await import('../../handlers/searchExecutionsHandler.js');
const ctx: ToolContext = { requestId: 't', timestamp: new Date() };
const UUID = '8511c14d-233c-44d0-b692-2dab9f485488';

const NEVER_SIGNED_IN = {
  uuid: UUID,
  status: 'completed',
  outcome: 'error',
  verdict: { outcome: 'error', reason: 'Did not submit the login as create-1@crochets.local.' },
  evaluation: { passed: null, outcome: 'error', reason: 'Did not submit the login as create-1@crochets.local.' },
  state: {
    outcome: 'pass',
    success: true,
    verdictOutcome: 'error',
    verdictSummary: 'We did not get signed in as create-1@crochets.local, so this run has no result.',
    'auth.modeUsed': 'skipped',
  },
  nodeExecutions: [],
};

async function lookup(exec: any) {
  mockInit.mockResolvedValue(undefined);
  mockGetExecution.mockResolvedValue(exec);
  const res = await searchExecutionsHandler({ uuid: exec.uuid } as any, ctx);
  return JSON.parse(res.content[0].text!).execution;
}

describe('executions uuid lookup shows one verdict', () => {
  test('a never-signed-in run reads error in state too, never pass/success', async () => {
    const e = await lookup(NEVER_SIGNED_IN);
    expect(e.outcome).toBe('error');
    expect(e.state.outcome).toBe('error');
    expect(e.state.success).toBe(false);
    expect(e.state.verdictSummary).toContain('did not get signed in');
  });

  test('a genuine pass stays pass', async () => {
    const e = await lookup({
      ...NEVER_SIGNED_IN,
      outcome: 'pass', verdict: { outcome: 'pass', reason: 'ok' },
      evaluation: { passed: true, outcome: 'pass', reason: 'ok' },
      state: { outcome: 'pass', success: true, verdictOutcome: 'pass' },
    });
    expect(e.state.outcome).toBe('pass');
    expect(e.state.success).toBe(true);
  });

  test('a run that never attempted a test has no verdict: state.outcome null, success false', async () => {
    const e = await lookup({
      ...NEVER_SIGNED_IN,
      outcome: null, verdict: { outcome: null, reason: 'CodeBuild failed', skipped: true },
      evaluation: { passed: null, outcome: null, reason: 'CodeBuild failed' },
      state: { outcome: 'skipped', success: false, verdictOutcome: 'skipped' },
    });
    expect(e.state.outcome).toBeNull();
    expect(e.state.success).toBe(false);
  });

  test('a run still going keeps its in-flight state untouched', async () => {
    const e = await lookup({
      uuid: UUID, status: 'running', outcome: null, verdict: { outcome: null },
      state: { stepsTaken: 2 }, nodeExecutions: [],
    });
    expect(e.state).toEqual({ stepsTaken: 2 });
  });

  test('without a top-level verdict, the stamped state.verdictOutcome decides', async () => {
    const e = await lookup({
      uuid: UUID, status: 'completed',
      state: { outcome: 'pass', success: true, verdictOutcome: 'error' }, nodeExecutions: [],
    });
    expect(e.state.outcome).toBe('error');
    expect(e.state.success).toBe(false);
  });
});
