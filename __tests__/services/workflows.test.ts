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

// ── findEvaluationTemplate ───────────────────────────────────────────────────

describe('findEvaluationTemplate()', () => {
  test('happy path: matches "App Evaluation Workflow Template" not "App Evaluation Brain"', async () => {
    const brain = makeTemplate({ uuid: 'brain', name: 'App Evaluation Brain' });
    const wrapper = makeTemplate({ uuid: 'wrapper', name: 'App Evaluation Workflow Template' });
    mockGet.mockResolvedValue({ results: [brain, wrapper] });

    const result = await service.findEvaluationTemplate();

    expect(result!.uuid).toBe('wrapper');
  });

  test('empty results: returns null', async () => {
    mockGet.mockResolvedValue({ results: [] });

    const result = await service.findEvaluationTemplate();

    expect(result).toBeNull();
  });

  test('null response results: returns null', async () => {
    mockGet.mockResolvedValue({});

    const result = await service.findEvaluationTemplate();

    expect(result).toBeNull();
  });

  test('results exist but none match "app evaluation workflow": throws with available-templates list', async () => {
    const templates = [
      makeTemplate({ uuid: 't1', name: 'Smoke Test Runner' }),
      makeTemplate({ uuid: 't2', name: 'App Evaluation Brain' }),
    ];
    mockGet.mockResolvedValue({ results: templates });

    await expect(service.findEvaluationTemplate()).rejects.toThrow(/No workflow template matching "app evaluation workflow"/);
    await expect(service.findEvaluationTemplate()).rejects.toThrow(/Smoke Test Runner/);
  });

  test('multiple templates: picks the correct one', async () => {
    const templates = [
      makeTemplate({ uuid: 't1', name: 'Something Else' }),
      makeTemplate({ uuid: 't2', name: 'Full App Evaluation Workflow v2' }),
      makeTemplate({ uuid: 't3', name: 'Another Workflow' }),
    ];
    mockGet.mockResolvedValue({ results: templates });

    const result = await service.findEvaluationTemplate();

    expect(result!.uuid).toBe('t2');
  });
});

// ── Slug-pinned dispatch (bead 56kd.1 / bug clka) ────────────────────────────

describe('findEvaluationTemplate() — slug-pinned dispatch', () => {
  const EVAL_SLUG = 'flow/e2es/app-eval';

  test('resolves by slug even when the backend RENAMES the template', async () => {
    // The whole point of bug clka: a backend display-name change must NOT break
    // dispatch. The template carries the stable slug but an unrelated name.
    const renamed = makeTemplate({ uuid: 'eval-uuid', name: 'Totally Different Name', slug: EVAL_SLUG });
    const decoy = makeTemplate({ uuid: 'decoy', name: 'App Evaluation Brain', slug: 'flow/e2es/app-eval-brain' });
    mockGet.mockResolvedValue({ results: [decoy, renamed], next: null });

    const result = await service.findEvaluationTemplate();

    expect(result!.uuid).toBe('eval-uuid');
  });

  test('sends the slug to the templates endpoint (server-side filter opportunity)', async () => {
    const renamed = makeTemplate({ uuid: 'eval-uuid', name: 'X', slug: EVAL_SLUG });
    mockGet.mockResolvedValue({ results: [renamed], next: null });

    await service.findEvaluationTemplate();

    expect(mockGet).toHaveBeenCalledWith(
      'api/v1/workflows/',
      expect.objectContaining({ isTemplate: true, slug: EVAL_SLUG, page: 1 }),
    );
  });

  test('client-side slug filter: ignores a same-page decoy whose slug differs', async () => {
    const decoy = makeTemplate({ uuid: 'decoy', name: 'App Evaluation Workflow Template', slug: 'flow/e2es/other' });
    const real = makeTemplate({ uuid: 'real', name: 'zzz', slug: EVAL_SLUG });
    mockGet.mockResolvedValue({ results: [decoy, real], next: null });

    const result = await service.findEvaluationTemplate();

    expect(result!.uuid).toBe('real');
  });

  test('DEBUGGAI_EVAL_TEMPLATE overrides the pinned slug', async () => {
    const saved = process.env.DEBUGGAI_EVAL_TEMPLATE;
    process.env.DEBUGGAI_EVAL_TEMPLATE = 'flow/custom/my-eval';
    try {
      const custom = makeTemplate({ uuid: 'custom-uuid', name: 'Custom', slug: 'flow/custom/my-eval' });
      mockGet.mockResolvedValue({ results: [custom], next: null });

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

  test('falls back to name-search when NO result carries a slug field (backend not yet deployed)', async () => {
    // Interim behavior until backend contract sentinal-k8x1f.8 exposes slug:
    // results have no slug field at all -> fall back to name-substring search.
    const wrapper = makeTemplate({ uuid: 'wrapper', name: 'App Evaluation Workflow Template' });
    delete (wrapper as any).slug;
    const brain = makeTemplate({ uuid: 'brain', name: 'App Evaluation Brain' });
    delete (brain as any).slug;
    mockGet.mockResolvedValue({ results: [brain, wrapper], next: null });

    const result = await service.findEvaluationTemplate();

    expect(result!.uuid).toBe('wrapper');
  });
});

// ── findTemplateByName ───────────────────────────────────────────────────────

describe('findTemplateByName()', () => {
  test('case-insensitive substring match: finds "Raw Crawl Workflow Template" by "raw crawl"', async () => {
    const template = makeTemplate({ uuid: 'tmpl-raw-crawl', name: 'Raw Crawl Workflow Template' });
    mockGet.mockResolvedValue({ results: [template] });

    const result = await service.findTemplateByName('raw crawl');

    expect(mockGet).toHaveBeenCalledWith('api/v1/workflows/', { isTemplate: true, search: 'raw crawl', page: 1 });
    expect(result).toEqual(template);
  });

  test('paginates past page 1: finds a template that sorts onto a later page', async () => {
    // Reproduces the prod bug (bead 8d32): the eval template is not on page 1,
    // and the backend ignores page_size, so reading only page 1 missed it and
    // check_app_in_browser threw "No workflow template matching ...".
    const page1 = {
      results: Array.from({ length: 10 }, (_, i) =>
        makeTemplate({ uuid: `p1-${i}`, name: `Other Template ${i}` })),
      next: 'https://api.debugg.ai/api/v1/workflows/?page=2',
    };
    const wrapper = makeTemplate({ uuid: 'wrapper', name: 'App Evaluation Workflow Template' });
    mockGet
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce({ results: [wrapper], next: null });

    const result = await service.findTemplateByName('app evaluation workflow');

    expect(result!.uuid).toBe('wrapper');
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet).toHaveBeenNthCalledWith(1, 'api/v1/workflows/', { isTemplate: true, search: 'app evaluation workflow', page: 1 });
    expect(mockGet).toHaveBeenNthCalledWith(2, 'api/v1/workflows/', { isTemplate: true, search: 'app evaluation workflow', page: 2 });
  });

  test('stops paginating once `next` is null (no infinite loop)', async () => {
    mockGet.mockResolvedValue({ results: [makeTemplate({ name: 'Unrelated' })], next: null });

    await expect(service.findTemplateByName('raw crawl')).rejects.toThrow(
      /No workflow template matching "raw crawl" found/,
    );
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  test('case-insensitive: uppercase keyword still matches lowercase template name', async () => {
    const template = makeTemplate({ uuid: 'tmpl-raw-crawl', name: 'raw crawl template' });
    mockGet.mockResolvedValue({ results: [template] });

    const result = await service.findTemplateByName('RAW CRAWL');

    expect(result).toEqual(template);
  });

  test('picks first match when multiple templates contain the keyword', async () => {
    const templates = [
      makeTemplate({ uuid: 't1', name: 'Something Unrelated' }),
      makeTemplate({ uuid: 't2', name: 'Raw Crawl Workflow Template' }),
      makeTemplate({ uuid: 't3', name: 'Another Raw Crawl Thing' }),
    ];
    mockGet.mockResolvedValue({ results: templates });

    const result = await service.findTemplateByName('raw crawl');

    expect(result!.uuid).toBe('t2');
  });

  test('empty results: returns null', async () => {
    mockGet.mockResolvedValue({ results: [] });

    const result = await service.findTemplateByName('raw crawl');

    expect(result).toBeNull();
  });

  test('templates exist but none match: throws clear error listing available names', async () => {
    const templates = [
      makeTemplate({ uuid: 't1', name: 'App Evaluation Workflow Template' }),
      makeTemplate({ uuid: 't2', name: 'Smoke Test Runner' }),
    ];
    mockGet.mockResolvedValue({ results: templates });

    await expect(service.findTemplateByName('raw crawl')).rejects.toThrow(
      /No workflow template matching "raw crawl" found/,
    );
    await expect(service.findTemplateByName('raw crawl')).rejects.toThrow(
      /App Evaluation Workflow Template/,
    );
  });

  test('findEvaluationTemplate remains functional (backwards compat wrapper)', async () => {
    const template = makeTemplate({ uuid: 'tmpl-eval', name: 'App Evaluation Workflow Template' });
    mockGet.mockResolvedValue({ results: [template] });

    const result = await service.findEvaluationTemplate();

    expect(result).toEqual(template);
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
