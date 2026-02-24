/**
 * Workflows Service
 * 4-step integration: find template → execute → poll → result
 */

import { AxiosTransport } from '../utils/axiosTransport.js';

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
  tunnelKey: string | null;
  ngrokKeyId: string | null;
  ngrokExpiresAt: string | null;
  resolvedEnvironmentId: string | null;
  resolvedCredentialId: string | null;
}

export interface WorkflowsService {
  findEvaluationTemplate(): Promise<WorkflowTemplate | null>;
  executeWorkflow(workflowUuid: string, contextData: Record<string, any>, env?: WorkflowEnv): Promise<WorkflowExecuteResponse>;
  getExecution(executionUuid: string): Promise<WorkflowExecution>;
  pollExecution(
    executionUuid: string,
    onUpdate?: (execution: WorkflowExecution) => Promise<void>
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
      const evalTemplate = templates.find(t =>
        t.name.toLowerCase().includes('app evaluation')
      );
      return evalTemplate ?? templates[0] ?? null;
    },

    async executeWorkflow(workflowUuid: string, contextData: Record<string, any>, env?: WorkflowEnv): Promise<WorkflowExecuteResponse> {
      const body: Record<string, any> = { contextData };
      if (env && Object.keys(env).length > 0) {
        body.env = env;
      }
      const response = await tx.post<{
        resourceUuid: string;
        tunnelKey?: string;
        ngrokKeyId?: string;
        ngrokExpiresAt?: string;
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
        tunnelKey: response.tunnelKey ?? null,
        ngrokKeyId: response.ngrokKeyId ?? null,
        ngrokExpiresAt: response.ngrokExpiresAt ?? null,
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
      onUpdate?: (execution: WorkflowExecution) => Promise<void>
    ): Promise<WorkflowExecution> {
      const deadline = Date.now() + EXECUTION_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const execution = await service.getExecution(executionUuid);
        if (onUpdate) {
          await onUpdate(execution).catch(() => {});
        }
        if (TERMINAL_STATUSES.has(execution.status)) {
          return execution;
        }
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      throw new Error(
        `Execution ${executionUuid} timed out after ${EXECUTION_TIMEOUT_MS / 1000}s`
      );
    }
  };

  return service;
};
