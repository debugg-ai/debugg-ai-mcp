/**
 * Workflows Service
 * 4-step integration: find template → execute → poll → result
 */

import { AxiosTransport } from '../utils/axiosTransport.js';
import { Telemetry, TelemetryEvents } from '../utils/telemetry.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const POLL_INTERVAL_MS = 3000;
const EXECUTION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

export interface WorkflowTemplate {
  uuid: string;
  name: string;
  description: string;
  isTemplate: boolean;
  isActive: boolean;
}

export interface NodeExecution {
  nodeId: string;
  nodeType: string;
  status: string;
  outputData?: Record<string, any>;
  inputData?: Record<string, any>;
  executionOrder: number;
  executionTimeMs?: number;
  error?: string;
}

export interface WorkflowExecution {
  uuid: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  state: {
    outcome: string;
    success: boolean;
    stepsTaken: number;
    error: string;
  } | null;
  errorMessage: string;
  errorInfo: { message?: string; failedNodeId?: string } | null;
  nodeExecutions: NodeExecution[];
}

export interface WorkflowEnv {
  environmentId?: string;
  credentialId?: string;
  credentialRole?: string;
  username?: string;
  password?: string;
}

export interface WorkflowExecuteResponse {
  executionUuid: string;
  resolvedEnvironmentId: string | null;
  resolvedCredentialId: string | null;
}

export interface WorkflowsService {
  findEvaluationTemplate(): Promise<WorkflowTemplate | null>;
  executeWorkflow(workflowUuid: string, contextData: Record<string, any>, env?: WorkflowEnv): Promise<WorkflowExecuteResponse>;
  getExecution(executionUuid: string): Promise<WorkflowExecution>;
  pollExecution(
    executionUuid: string,
    onUpdate?: (execution: WorkflowExecution) => Promise<void>,
    signal?: AbortSignal
  ): Promise<WorkflowExecution>;
}

export const createWorkflowsService = (tx: AxiosTransport): WorkflowsService => {
  const service: WorkflowsService = {
    async findEvaluationTemplate(): Promise<WorkflowTemplate | null> {
      const response = await tx.get<{ results: WorkflowTemplate[] }>(
        'api/v1/workflows/',
        { isTemplate: true }
      );
      const templates = response?.results ?? [];
      if (templates.length === 0) return null;

      const evalTemplate = templates.find(t =>
        t.name.toLowerCase().includes('app evaluation')
      );
      if (!evalTemplate) {
        throw new Error(
          `No "App Evaluation" workflow template found. ` +
          `Available templates: ${templates.map(t => `"${t.name}"`).join(', ')}. ` +
          `Ensure the backend has a template with "App Evaluation" in its name.`
        );
      }
      return evalTemplate;
    },

    async executeWorkflow(workflowUuid: string, contextData: Record<string, any>, env?: WorkflowEnv): Promise<WorkflowExecuteResponse> {
      const body: Record<string, any> = { contextData };
      if (env && Object.keys(env).length > 0) {
        body.env = env;
      }
      const response = await tx.post<{
        resourceUuid: string;
        resolvedEnvironmentId?: string;
        resolvedCredentialId?: string;
      }>(
        `api/v1/workflows/${workflowUuid}/execute/`,
        body
      );
      if (!response?.resourceUuid) {
        throw new Error('Workflow execution failed: no execution UUID returned');
      }
      return {
        executionUuid: response.resourceUuid,
        resolvedEnvironmentId: response.resolvedEnvironmentId ?? null,
        resolvedCredentialId: response.resolvedCredentialId ?? null,
      };
    },

    async getExecution(executionUuid: string): Promise<WorkflowExecution> {
      const response = await tx.get<WorkflowExecution>(
        `api/v1/workflows/executions/${executionUuid}/`
      );
      if (!response) {
        throw new Error(`Execution not found: ${executionUuid}`);
      }
      return response;
    },

    async pollExecution(
      executionUuid: string,
      onUpdate?: (execution: WorkflowExecution) => Promise<void>,
      signal?: AbortSignal
    ): Promise<WorkflowExecution> {
      const deadline = Date.now() + EXECUTION_TIMEOUT_MS;
      const pollStart = Date.now();
      let pollCount = 0;
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          throw new Error(`Polling cancelled for execution ${executionUuid}`);
        }
        const execution = await service.getExecution(executionUuid);
        pollCount++;
        if (onUpdate) {
          await onUpdate(execution).catch(() => {});
        }
        if (TERMINAL_STATUSES.has(execution.status)) {
          Telemetry.capture(TelemetryEvents.WORKFLOW_EXECUTED, {
            status: execution.status,
            success: execution.state?.success ?? false,
            outcome: execution.state?.outcome ?? null,
            stepsTaken: execution.state?.stepsTaken ?? 0,
            durationMs: Date.now() - pollStart,
            pollCount,
          });
          return execution;
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, POLL_INTERVAL_MS);
          if (signal) {
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error(`Polling cancelled for execution ${executionUuid}`));
            }, { once: true });
          }
        });
      }
      throw new Error(
        `Execution ${executionUuid} timed out after ${EXECUTION_TIMEOUT_MS / 1000}s`
      );
    }
  };

  return service;
};
