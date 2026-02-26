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
  test('happy path: returns template whose name contains "app evaluation" (case-insensitive)', async () => {
    const template = makeTemplate({ name: 'My App Evaluation Template' });
    mockGet.mockResolvedValue({ results: [template] });

    const result = await service.findEvaluationTemplate();

    expect(mockGet).toHaveBeenCalledWith('api/v1/workflows/', { isTemplate: true });
    expect(result).toEqual(template);
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

  test('results exist but none match "App Evaluation": throws error listing names', async () => {
    const templates = [
      makeTemplate({ uuid: 't1', name: 'Smoke Test Runner' }),
      makeTemplate({ uuid: 't2', name: 'Performance Benchmark' }),
    ];
    mockGet.mockResolvedValue({ results: templates });

    await expect(service.findEvaluationTemplate()).rejects.toThrow(
      /No "App Evaluation" workflow template found/
    );
    await expect(service.findEvaluationTemplate()).rejects.toThrow(
      /Smoke Test Runner/
    );
  });

  test('multiple templates: picks the correct one', async () => {
    const templates = [
      makeTemplate({ uuid: 't1', name: 'Something Else' }),
      makeTemplate({ uuid: 't2', name: 'Full App Evaluation v2' }),
      makeTemplate({ uuid: 't3', name: 'Another Workflow' }),
    ];
    mockGet.mockResolvedValue({ results: templates });

    const result = await service.findEvaluationTemplate();

    expect(result!.uuid).toBe('t2');
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

  test('deadline exceeded before terminal status: throws timeout error', async () => {
    // Always return 'running'
    mockGet.mockResolvedValue(makeExecution({ status: 'running' }));

    jest.useFakeTimers();

    const pollPromise = service.pollExecution('exec-stuck');

    // Attach the rejection handler BEFORE advancing timers so we don't get unhandled rejection
    const resultPromise = pollPromise.then(
      () => { throw new Error('should have rejected'); },
      (err: Error) => err,
    );

    // Advance past the 10-minute deadline in large steps
    for (let i = 0; i < 210; i++) {
      await jest.advanceTimersByTimeAsync(3000);
    }

    const err = await resultPromise;
    expect(err.message).toMatch(/timed out/);
  });
});
