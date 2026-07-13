/**
 * WorkflowsService tests.
 *
 * Covers:
 *  - findEvaluationTemplate: happy path, empty, no match, multiple templates
 *  - executeWorkflow: env handling, resourceUuid mapping, null coalescing, missing UUID
 *  - getExecution: returns data, null/undefined throws
 *  - pollExecution: onUpdate callback error, timeout
 */

import { jest } from '@jest/globals';
import type { WorkflowsService, WorkflowExecution, WorkflowTemplate } from '../../services/workflows.js';
import { createWorkflowsService } from '../../services/workflows.js';

// Mock transport
const mockGet = jest.fn<(...args: any[]) => Promise<any>>();
const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
const mockTx = { get: mockGet, post: mockPost } as any;

let service: WorkflowsService;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  service = createWorkflowsService(mockTx);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTemplate(overrides: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  return {
    uuid: 'tmpl-1',
    name: 'App Evaluation Workflow',
    description: 'Evaluates an app',
    isTemplate: true,
    isActive: true,
    ...overrides,
  };
}

function makeExecution(overrides: Partial<WorkflowExecution> = {}): WorkflowExecution {
  return {
    uuid: 'exec-1',
    status: 'running',
    startedAt: '2026-02-25T00:00:00Z',
    completedAt: null,
    durationMs: null,
    state: null,
    errorMessage: '',
    errorInfo: null,
    nodeExecutions: [],
    ...overrides,
  };
}

// ── findTemplateBySlug — pure server-side ?slug= resolve (bead 56kd.8) ────────
// The backend (contract sentinal-k8x1f.11) does exact `?slug=` matching
// server-side and returns exactly that template. The resolver is a single GET,
// no page-walk, no client-side name/slug filtering, no name fallback.

describe('findTemplateBySlug()', () => {
  test('sends ?slug= to the templates endpoint in a single GET (server-side exact match)', async () => {
    const t = makeTemplate({ uuid: 'probe-uuid', name: 'Page Probe Workflow Template', slug: 'flow/tools/probe' });
    mockGet.mockResolvedValue({ results: [t] });

    const result = await service.findTemplateBySlug('flow/tools/probe');

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('api/v1/workflows/', { isTemplate: true, slug: 'flow/tools/probe' });
    expect(result!.uuid).toBe('probe-uuid');
  });

  test('a backend RENAME does not break resolution (slug is the stable identity)', async () => {
    const renamed = makeTemplate({ uuid: 'crawl-uuid', name: 'Totally Different Name', slug: 'crawl-execution-workflow-template' });
    mockGet.mockResolvedValue({ results: [renamed] });

    const result = await service.findTemplateBySlug('crawl-execution-workflow-template');

    expect(result!.uuid).toBe('crawl-uuid');
  });

  test('empty results: returns null', async () => {
    mockGet.mockResolvedValue({ results: [] });
    expect(await service.findTemplateBySlug('flow/tools/probe')).toBeNull();
  });

  test('null response results: returns null', async () => {
    mockGet.mockResolvedValue({});
    expect(await service.findTemplateBySlug('flow/tools/probe')).toBeNull();
  });
});

// ── findEvaluationTemplate — pure slug, name fallback RETIRED (bead 56kd.8) ───

describe('findEvaluationTemplate()', () => {
  const EVAL_SLUG = 'flow/e2es/app-eval';

  test('resolves the app-eval template by its stable slug (single GET)', async () => {
    const renamed = makeTemplate({ uuid: 'eval-uuid', name: 'Totally Different Name', slug: EVAL_SLUG });
    mockGet.mockResolvedValue({ results: [renamed] });

    const result = await service.findEvaluationTemplate();

    expect(result!.uuid).toBe('eval-uuid');
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('api/v1/workflows/', { isTemplate: true, slug: EVAL_SLUG });
  });

  test('empty results: returns null WITHOUT a name-substring fallback (single GET, no second search)', async () => {
    mockGet.mockResolvedValue({ results: [] });

    const result = await service.findEvaluationTemplate();

    expect(result).toBeNull();
    expect(mockGet).toHaveBeenCalledTimes(1); // a retired name fallback would issue a 2nd `search` call
  });

  test('never sends a `search` (name) param — resolution is slug-only', async () => {
    mockGet.mockResolvedValue({ results: [] });
    await service.findEvaluationTemplate();
    const params = mockGet.mock.calls[0][1] as Record<string, any>;
    expect(params).not.toHaveProperty('search');
  });
});

// ── Slug override + fuzzy-name retirement (bead 56kd.8) ──────────────────────

describe('findEvaluationTemplate() — env override + fuzzy-name retirement', () => {
  test('DEBUGGAI_EVAL_TEMPLATE overrides the pinned slug', async () => {
    const saved = process.env.DEBUGGAI_EVAL_TEMPLATE;
    process.env.DEBUGGAI_EVAL_TEMPLATE = 'flow/custom/my-eval';
    try {
      const custom = makeTemplate({ uuid: 'custom-uuid', name: 'Custom', slug: 'flow/custom/my-eval' });
      mockGet.mockResolvedValue({ results: [custom] });

      const result = await service.findEvaluationTemplate();

      expect(result!.uuid).toBe('custom-uuid');
      expect(mockGet).toHaveBeenCalledWith(
        'api/v1/workflows/',
        expect.objectContaining({ slug: 'flow/custom/my-eval' }),
      );
    } finally {
      if (saved === undefined) delete process.env.DEBUGGAI_EVAL_TEMPLATE;
      else process.env.DEBUGGAI_EVAL_TEMPLATE = saved;
    }
  });

  test('findTemplateByName is GONE from the service surface (fuzzy-name resolution retired)', () => {
    expect((service as any).findTemplateByName).toBeUndefined();
  });
});

// ── executeWorkflow ──────────────────────────────────────────────────────────

describe('executeWorkflow()', () => {
  const workflowUuid = 'wf-abc';
  const contextData = { url: 'https://example.com', description: 'Test app' };

  test('no env: body has contextData only, no env field', async () => {
    mockPost.mockResolvedValue({ resourceUuid: 'exec-1' });

    await service.executeWorkflow(workflowUuid, contextData);

    const [url, body] = mockPost.mock.calls[0];
    expect(url).toBe(`api/v1/workflows/${workflowUuid}/execute/`);
    expect(body).toEqual({ contextData });
    expect(body).not.toHaveProperty('env');
  });

  test('empty env {}: body still has no env field', async () => {
    mockPost.mockResolvedValue({ resourceUuid: 'exec-1' });

    await service.executeWorkflow(workflowUuid, contextData, {});

    const [, body] = mockPost.mock.calls[0];
    expect(body).not.toHaveProperty('env');
  });

  test('non-empty env: body includes env', async () => {
    mockPost.mockResolvedValue({ resourceUuid: 'exec-1' });

    const env = { environmentId: 'env-1', credentialId: 'cred-1' };
    await service.executeWorkflow(workflowUuid, contextData, env);

    const [, body] = mockPost.mock.calls[0];
    expect(body.env).toEqual(env);
  });

  test('maps response.resourceUuid to executionUuid', async () => {
    mockPost.mockResolvedValue({ resourceUuid: 'exec-uuid-mapped' });

    const result = await service.executeWorkflow(workflowUuid, contextData);

    expect(result.executionUuid).toBe('exec-uuid-mapped');
  });

  test('resolvedEnvironmentId and resolvedCredentialId null-coalesced', async () => {
    mockPost.mockResolvedValue({
      resourceUuid: 'exec-1',
      // no resolvedEnvironmentId or resolvedCredentialId in response
    });

    const result = await service.executeWorkflow(workflowUuid, contextData);

    expect(result.resolvedEnvironmentId).toBeNull();
    expect(result.resolvedCredentialId).toBeNull();
  });

  test('resolvedEnvironmentId and resolvedCredentialId passed through when present', async () => {
    mockPost.mockResolvedValue({
      resourceUuid: 'exec-1',
      resolvedEnvironmentId: 'env-resolved',
      resolvedCredentialId: 'cred-resolved',
    });

    const result = await service.executeWorkflow(workflowUuid, contextData);

    expect(result.resolvedEnvironmentId).toBe('env-resolved');
    expect(result.resolvedCredentialId).toBe('cred-resolved');
  });

  test('no resourceUuid in response: throws "Workflow execution failed"', async () => {
    mockPost.mockResolvedValue({});

    await expect(service.executeWorkflow(workflowUuid, contextData)).rejects.toThrow(
      'Workflow execution failed'
    );
  });

  test('null response: throws "Workflow execution failed"', async () => {
    mockPost.mockResolvedValue(null);

    await expect(service.executeWorkflow(workflowUuid, contextData)).rejects.toThrow(
      'Workflow execution failed'
    );
  });
});

// ── getExecution ─────────────────────────────────────────────────────────────

describe('getExecution()', () => {
  test('returns execution object', async () => {
    const execution = makeExecution({ uuid: 'exec-42', status: 'completed' });
    mockGet.mockResolvedValue(execution);

    const result = await service.getExecution('exec-42');

    expect(mockGet).toHaveBeenCalledWith('api/v1/workflows/executions/exec-42/');
    expect(result).toEqual(execution);
  });

  test('null response: throws "Execution not found"', async () => {
    mockGet.mockResolvedValue(null);

    await expect(service.getExecution('exec-gone')).rejects.toThrow('Execution not found');
  });

  test('undefined response: throws "Execution not found"', async () => {
    mockGet.mockResolvedValue(undefined);

    await expect(service.getExecution('exec-gone')).rejects.toThrow('Execution not found');
  });
});

// ── pollExecution ────────────────────────────────────────────────────────────

describe('pollExecution()', () => {
  test('onUpdate callback throws: polling continues and returns terminal status', async () => {
    let callCount = 0;
    mockGet.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) return makeExecution({ status: 'running' });
      return makeExecution({ status: 'completed' });
    });

    const onUpdate = jest.fn<(e: WorkflowExecution) => Promise<void>>().mockRejectedValue(
      new Error('callback boom')
    );

    jest.useFakeTimers();

    const pollPromise = service.pollExecution('exec-1', onUpdate);

    // Advance through poll intervals
    // First iteration: getExecution returns 'running', onUpdate throws, then waits POLL_INTERVAL_MS
    await jest.advanceTimersByTimeAsync(0); // let first getExecution resolve
    await jest.advanceTimersByTimeAsync(3000); // first poll interval
    await jest.advanceTimersByTimeAsync(3000); // second poll interval

    const result = await pollPromise;

    expect(result.status).toBe('completed');
    expect(onUpdate).toHaveBeenCalled();
  });

  test('deadline exceeded: returns the last observed execution flagged timedOut (bead 56kd.3), does NOT throw', async () => {
    // The 10-min poll deadline must NOT discard captured evidence. Instead of
    // throwing, pollExecution returns the last observed (non-terminal)
    // execution flagged `timedOut` so the handler can shape a partial result.
    mockGet.mockResolvedValue(makeExecution({
      status: 'running',
      nodeExecutions: [
        { nodeId: 'b1', nodeType: 'brain.step', status: 'success', executionOrder: 1, outputData: { decision: { intent: 'x' } } },
      ],
    }));

    jest.useFakeTimers();

    const settled = service.pollExecution('exec-stuck').then(
      (v) => ({ value: v }),
      (e: Error) => ({ error: e }),
    );

    // Advance past the 10-minute deadline in large steps
    for (let i = 0; i < 210; i++) {
      await jest.advanceTimersByTimeAsync(3000);
    }

    const outcome = await settled as { value?: WorkflowExecution; error?: Error };
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBeDefined();
    expect(outcome.value!.timedOut).toBe(true);
    expect(outcome.value!.status).toBe('running');          // last observed status
    expect(outcome.value!.nodeExecutions).toHaveLength(1);  // partial evidence preserved
  });
});
