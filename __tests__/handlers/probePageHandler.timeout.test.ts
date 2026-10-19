/**
 * platform-4cvj.77: probe_page must never answer a timed-out or failed run with
 * silent nulls, and must match captures to targets by target, not by position.
 *
 * Prod 2026-10-19, execution a04ca406 (7 targets): the 10-min poll deadline fell
 * before the first browser.capture. pollExecution returned the last snapshot with
 * timedOut=true, the handler never read it, and every target came back with
 * statusCode/title/finalUrl null and NO error field.
 */

import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockFindTemplateBySlug = jest.fn<(kw: string) => Promise<any>>();
const mockExecute = jest.fn<(...args: any[]) => Promise<any>>();
const mockPoll = jest.fn<() => Promise<any>>();
const mockInit = jest.fn<() => Promise<void>>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    tunnels: {},
    workflows: {
      findTemplateBySlug: mockFindTemplateBySlug,
      executeWorkflow: mockExecute,
      pollExecution: mockPoll,
    },
  })),
}));

jest.unstable_mockModule('../../utils/tunnelContext.js', () => ({
  resolveTargetUrl: (i: any) => i.url,
  buildContext: (url: string) => ({ originalUrl: url, targetUrl: url, isLocalhost: false }),
  findExistingTunnel: () => null,
  ensureTunnel: jest.fn(),
  acquirePortRoute: async (ctx: any) => ctx,
  releasePortRoute: jest.fn(),
  sanitizeResponseUrls: (v: any) => v,
  touchTunnelById: jest.fn(),
}));

const { probePageHandler } = await import('../../handlers/probePageHandler.js');

const ctx: ToolContext = { requestId: 't', timestamp: new Date() };
const TARGETS = [
  { url: 'https://example.com/a' },
  { url: 'https://example.com/b' },
  { url: 'https://example.com/c' },
];

function capture(order: number, extra: Record<string, any>) {
  return {
    nodeType: 'browser.capture', executionOrder: order, status: 'success',
    outputData: { statusCode: 200, consoleSlice: [], networkSummary: [], ...extra },
  };
}

async function run(execution: any) {
  mockInit.mockResolvedValue(undefined);
  mockFindTemplateBySlug.mockResolvedValue({ uuid: 'tmpl', name: 'Page Probe' });
  mockExecute.mockResolvedValue({ executionUuid: 'exec-1' });
  mockPoll.mockResolvedValue(execution);
  const res = await probePageHandler({ targets: TARGETS } as any, ctx);
  return { res, body: JSON.parse(res.content[0].text!) };
}

beforeEach(async () => {
  jest.clearAllMocks();
  const { invalidateTemplateCache } = await import('../../utils/handlerCaches.js');
  invalidateTemplateCache();
});

describe('probe_page on a poll-deadline timeout (prod a04ca406)', () => {
  const timedOut = {
    uuid: 'exec-1', status: 'running', timedOut: true,
    pollTimeout: { elapsedMs: 603860, pollCount: 70 },
    nodeExecutions: [{ nodeType: 'browser.setup', executionOrder: 1, status: 'success', outputData: {} }],
    state: {},
  };

  test('every target carries an error naming the execution and the deadline', async () => {
    const { body } = await run(timedOut);
    expect(body.results).toHaveLength(3);
    for (const r of body.results) {
      expect(typeof r.error).toBe('string');
      expect(r.error).toContain('exec-1');
      expect(r.error).toContain('604s');
      expect(r.statusCode).toBeNull();
    }
  });

  test('the response says the run has no result: outcome error with the poll facts', async () => {
    const { res, body } = await run(timedOut);
    expect(body.outcome).toBe('error');
    expect(body.reason).toContain('No result from execution exec-1');
    expect(body.reason).toContain('last status: running');
    expect(res.isError).toBe(true);
  });

  test('a capture that DID land before the deadline is kept; the rest are errors', async () => {
    const { res, body } = await run({
      ...timedOut,
      nodeExecutions: [capture(2, { targetIndex: 0, requestedUrl: TARGETS[0].url, title: 'A', capturedUrl: TARGETS[0].url })],
    });
    expect(body.results[0].title).toBe('A');
    expect(body.results[0].error).toBeUndefined();
    expect(body.results[1].error).toContain('exec-1');
    expect(body.results[2].error).toContain('exec-1');
    expect(body.outcome).toBe('error');
    expect(res.isError).toBeFalsy();
  });
});

describe('probe_page on a run the backend failed', () => {
  test('targets without a capture carry the backend error', async () => {
    const { body } = await run({
      uuid: 'exec-1', status: 'failed',
      errorMessage: 'Execution timed out after 672s (limit: 600s)',
      nodeExecutions: [], state: { outcome: 'timeout' },
    });
    for (const r of body.results) {
      expect(r.error).toContain('Execution timed out after 672s');
    }
    expect(body.outcome).toBe('error');
    expect(body.reason).toContain('Execution timed out after 672s');
  });
});

describe('captures are matched to targets by target, not by position', () => {
  test('a missing middle capture never shifts the next target onto it', async () => {
    const { body } = await run({
      uuid: 'exec-1', status: 'completed',
      nodeExecutions: [
        capture(3, { targetIndex: 0, title: 'A', capturedUrl: TARGETS[0].url }),
        capture(7, { targetIndex: 2, title: 'C', capturedUrl: TARGETS[2].url }),
      ],
      state: { outcome: 'pass' },
    });
    expect(body.results[0].title).toBe('A');
    expect(body.results[1].title).toBeNull();
    expect(body.results[1].error).toContain('exec-1');
    expect(body.results[2].title).toBe('C');
  });

  test('requestedUrl matches when the index is absent', async () => {
    const { body } = await run({
      uuid: 'exec-1', status: 'completed',
      nodeExecutions: [
        capture(3, { requestedUrl: TARGETS[2].url, title: 'C' }),
        capture(5, { requestedUrl: TARGETS[0].url, title: 'A' }),
      ],
      state: { outcome: 'pass' },
    });
    expect(body.results[0].title).toBe('A');
    expect(body.results[1].error).toBeDefined();
    expect(body.results[2].title).toBe('C');
  });

  test('a clean completed run has no top-level outcome/error fields (shape unchanged)', async () => {
    const { res, body } = await run({
      uuid: 'exec-1', status: 'completed',
      nodeExecutions: TARGETS.map((t, i) => capture(i + 2, { targetIndex: i, title: `T${i}` })),
      state: { outcome: 'pass' },
    });
    expect(body.outcome).toBeUndefined();
    expect(body.results.every((r: any) => r.error === undefined)).toBe(true);
    expect(res.isError).toBeFalsy();
  });
});
