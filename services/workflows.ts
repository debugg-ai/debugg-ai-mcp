/**
 * Workflows Service
 * 4-step integration: find template → execute → poll → result
 */

import { AxiosTransport } from '../utils/axiosTransport.js';
import { Logger } from '../utils/logger.js';
import { Telemetry, TelemetryEvents } from '../utils/telemetry.js';

const logger = new Logger({ module: 'workflows' });

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
// Exponential backoff polling: short executions (10-15s crawls) detect terminal
// status quickly via the early polls; long executions (60-150s browser runs)
// avoid hammering the backend with 20+ roundtrips. Cap at 5s so we never wait
// more than 5s past terminal-state achievement.
const POLL_INTERVAL_INITIAL_MS = 1000;
const POLL_INTERVAL_MAX_MS = 5000;
const POLL_BACKOFF_MULTIPLIER = 1.5;
const EXECUTION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
// A single poll GET can fail transiently (the global 30s axios timeout firing
// on a slow backend, a 5xx during a deploy, a TCP reset) WHILE the execution is
// still running server-side. Aborting the whole check on one bad poll loses an
// otherwise-healthy run — exactly the "client gives up, run is lost" failure the
// MCR-iOS agent reported. So we tolerate up to N *consecutive* poll failures and
// keep polling until the deadline; only a sustained outage (backend genuinely
// unreachable) gives up. The deadline still bounds total wall-clock either way.
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

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

/**
 * Per-execution browser session metadata.
 *
 * Backend release 2026-04-25 added harUrl + consoleLogUrl as presigned S3
 * URLs alongside the existing recordingUrl. URLs are short-lived — refetch
 * the parent execution to renew.
 *
 * Backend follow-up 2026-04-26 (bead 3yw6) added per-artifact status fields
 * that disambiguate "not produced" from "produced and failed":
 *   harStatus / consoleLogStatus            — known values include 'downloaded',
 *                                             'not_available', 'failed', 'queued'
 *   harRedactionStatus / consoleLogRedactionStatus
 *                                           — known values include 'redacted',
 *                                             'redaction_failed'; null when not
 *                                             applicable (no auth headers, etc.)
 *
 * All fields are nullable. Until backend deploy lands, the new status fields
 * may be absent from older sessions.
 */
export interface BrowserSession {
  uuid?: string;
  status?: string;
  vncWsPath?: string | null;
  recordingUrl?: string | null;
  recordingStatus?: string | null;
  harUrl?: string | null;
  consoleLogUrl?: string | null;
  harStatus?: string | null;
  consoleLogStatus?: string | null;
  harRedactionStatus?: string | null;
  consoleLogRedactionStatus?: string | null;
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
  browserSession?: BrowserSession | null;
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
  findTemplateByName(keyword: string): Promise<WorkflowTemplate | null>;
  findEvaluationTemplate(): Promise<WorkflowTemplate | null>;
  executeWorkflow(workflowUuid: string, contextData: Record<string, any>, env?: WorkflowEnv): Promise<WorkflowExecuteResponse>;
  getExecution(executionUuid: string): Promise<WorkflowExecution>;
  pollExecution(
    executionUuid: string,
    onUpdate?: (execution: WorkflowExecution) => Promise<void>,
    signal?: AbortSignal
  ): Promise<WorkflowExecution>;
  listExecutions(filters: { status?: string; projectId?: string; page: number; pageSize: number }): Promise<{ pageInfo: import('../utils/pagination.js').PageInfo; executions: any[] }>;
  cancelExecution(executionUuid: string): Promise<void>;
}

export const createWorkflowsService = (tx: AxiosTransport): WorkflowsService => {
  const service: WorkflowsService = {
    async findTemplateByName(keyword: string): Promise<WorkflowTemplate | null> {
      // Narrow server-side with `search` AND walk every page. The backend caps
      // the page size (it ignores page_size), so reading only page 1 silently
      // hides templates that sort later — that bug made check_app_in_browser
      // fail in prod because "App Evaluation Workflow Template" sat on page 2.
      // `search` collapses the candidate set to one page on backends that
      // support it; `page` paging is the fallback for those that ignore it.
      const needle = keyword.toLowerCase();
      const seenNames: string[] = [];
      const MAX_PAGES = 50; // safety valve against a backend that always returns `next`

      for (let page = 1; page <= MAX_PAGES; page++) {
        const response = await tx.get<{ results?: WorkflowTemplate[]; next?: string | null }>(
          'api/v1/workflows/',
          { isTemplate: true, search: keyword, page },
        );
        const templates = response?.results ?? [];
        for (const t of templates) {
          seenNames.push(t.name);
          if (t.name.toLowerCase().includes(needle)) return t;
        }
        if (!response?.next) break;
      }

      if (seenNames.length === 0) return null;
      throw new Error(
        `No workflow template matching "${keyword}" found. ` +
        `Available templates: ${seenNames.map(n => `"${n}"`).join(', ')}. ` +
        `Ensure the backend has a template with "${keyword}" in its name.`,
      );
    },

    async findEvaluationTemplate(): Promise<WorkflowTemplate | null> {
      // 'app evaluation workflow' is specific enough to skip 'App Evaluation Brain'
      // (subworkflow, no browser lifecycle) which also contains 'app evaluation'.
      const keyword = process.env.DEBUGGAI_EVAL_TEMPLATE || 'app evaluation workflow';
      return service.findTemplateByName(keyword);
    },

    async executeWorkflow(workflowUuid: string, contextData: Record<string, any>, env?: WorkflowEnv): Promise<WorkflowExecuteResponse> {
      const body: Record<string, any> = { contextData };
      // Send projectId at top level too — backend may read it from either location
      if (contextData.projectId) {
        body.projectId = contextData.projectId;
      }
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

    async listExecutions(filters) {
      const { makePageInfo } = await import('../utils/pagination.js');
      const params: Record<string, any> = { page: filters.page, pageSize: filters.pageSize };
      if (filters.status) params.status = filters.status;
      if (filters.projectId) params.projectId = filters.projectId;
      const response = await tx.get<{ count: number; next: string | null; results: any[] }>(
        'api/v1/workflows/executions/',
        params,
      );
      return {
        pageInfo: makePageInfo(filters.page, filters.pageSize, response?.count ?? 0, response?.next),
        executions: (response?.results ?? []).map((e: any) => ({
          uuid: e.uuid,
          workflow: e.workflow,
          status: e.status,
          mode: e.mode,
          source: e.source,
          outcome: e.outcome ?? null,
          startedAt: e.startedAt,
          completedAt: e.completedAt,
          durationMs: e.durationMs,
          timestamp: e.timestamp,
        })),
      };
    },

    async cancelExecution(executionUuid: string): Promise<void> {
      await tx.post(`api/v1/workflows/executions/${executionUuid}/cancel/`, {});
    },

    async pollExecution(
      executionUuid: string,
      onUpdate?: (execution: WorkflowExecution) => Promise<void>,
      signal?: AbortSignal
    ): Promise<WorkflowExecution> {
      const deadline = Date.now() + EXECUTION_TIMEOUT_MS;
      const pollStart = Date.now();
      let pollCount = 0;
      let consecutiveFailures = 0;
      let intervalMs = POLL_INTERVAL_INITIAL_MS;
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          throw new Error(`Polling cancelled for execution ${executionUuid}`);
        }
        let execution: WorkflowExecution;
        try {
          execution = await service.getExecution(executionUuid);
          consecutiveFailures = 0;
        } catch (err) {
          // The run is still alive on the backend — a single failed status poll
          // must not lose it. Tolerate a bounded run of consecutive failures,
          // then give up only if the backend looks genuinely unreachable.
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            throw new Error(
              `Lost contact with execution ${executionUuid} after ${consecutiveFailures} ` +
              `consecutive failed status polls: ${err instanceof Error ? err.message : String(err)}`
            );
          }
          logger.warn(
            `Status poll ${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES} failed for ` +
            `execution ${executionUuid}; run still active server-side, retrying after backoff`,
            { error: err instanceof Error ? err.message : String(err) }
          );
          // Fall through to the shared backoff sleep below before retrying.
          if (signal?.aborted) {
            throw new Error(`Polling cancelled for execution ${executionUuid}`);
          }
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, intervalMs);
            if (signal) {
              const onAbort = () => { clearTimeout(timer); reject(new Error(`Polling cancelled for execution ${executionUuid}`)); };
              if (signal.aborted) { clearTimeout(timer); reject(new Error(`Polling cancelled for execution ${executionUuid}`)); return; }
              signal.addEventListener('abort', onAbort, { once: true });
            }
          });
          intervalMs = Math.min(Math.round(intervalMs * POLL_BACKOFF_MULTIPLIER), POLL_INTERVAL_MAX_MS);
          continue;
        }
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
            finalIntervalMs: intervalMs,
          });
          return execution;
        }
        // Check abort before sleeping to avoid missing a signal fired between polls
        if (signal?.aborted) {
          throw new Error(`Polling cancelled for execution ${executionUuid}`);
        }
        const sleepMs = intervalMs;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, sleepMs);
          if (signal) {
            const onAbort = () => { clearTimeout(timer); reject(new Error(`Polling cancelled for execution ${executionUuid}`)); };
            if (signal.aborted) { clearTimeout(timer); reject(new Error(`Polling cancelled for execution ${executionUuid}`)); return; }
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
        // Backoff for next iteration — capped at MAX so we don't wait too long
        // past terminal-state achievement on the longest runs.
        intervalMs = Math.min(Math.round(intervalMs * POLL_BACKOFF_MULTIPLIER), POLL_INTERVAL_MAX_MS);
      }
      throw new Error(
        `Execution ${executionUuid} timed out after ${EXECUTION_TIMEOUT_MS / 1000}s`
      );
    }
  };

  return service;
};
