/**
 * Workflows Service
 * 4-step integration: find template → execute → poll → result
 */

import { AxiosTransport } from '../utils/axiosTransport.js';
import { Telemetry, TelemetryEvents } from '../utils/telemetry.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
// Exponential backoff polling: short executions (10-15s crawls) detect terminal
// status quickly via the early polls; long executions (60-150s browser runs)
// avoid hammering the backend with 20+ roundtrips. Cap at 5s so we never wait
// more than 5s past terminal-state achievement.
const POLL_INTERVAL_INITIAL_MS = 1000;
const POLL_INTERVAL_MAX_MS = 5000;
const POLL_BACKOFF_MULTIPLIER = 1.5;
const EXECUTION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

/**
 * Stable dispatch slugs for the three MCP browser workflows (bug clka /
 * bead 56kd.8). All three handlers pin to a STABLE slug so a backend
 * display-name change (or template rework) never breaks dispatch — the
 * fuzzy name-substring fallback is fully retired now that the backend does
 * server-side `?slug=` exact matching (contract sentinal-k8x1f.11).
 *
 * Each is env-overridable to pin a different slug without a code change.
 */
export const EVAL_TEMPLATE_SLUG = 'flow/e2es/app-eval';                       // check_app_in_browser
export const PAGE_PROBE_TEMPLATE_SLUG = 'flow/tools/probe';                   // probe_page
export const RAW_CRAWL_TEMPLATE_SLUG = 'crawl-execution-workflow-template';   // trigger_crawl

/** The slug the eval-template dispatch pins to (env-overridable). */
export function getEvalTemplateSlug(): string {
  return process.env.DEBUGGAI_EVAL_TEMPLATE || EVAL_TEMPLATE_SLUG;
}

/** The slug the page-probe dispatch pins to (env-overridable). */
export function getPageProbeTemplateSlug(): string {
  return process.env.DEBUGGAI_PROBE_TEMPLATE || PAGE_PROBE_TEMPLATE_SLUG;
}

/** The slug the raw-crawl dispatch pins to (env-overridable). */
export function getCrawlTemplateSlug(): string {
  return process.env.DEBUGGAI_CRAWL_TEMPLATE || RAW_CRAWL_TEMPLATE_SLUG;
}

export interface WorkflowTemplate {
  uuid: string;
  name: string;
  description: string;
  isTemplate: boolean;
  isActive: boolean;
  // Stable dispatch identifier (bug clka). Backend contract sentinal-k8x1f.8
  // exposes this on template results so the MCP can pin to the slug instead of
  // a mutable display name. Optional until that backend deploy lands.
  slug?: string;
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
  // Backend explicit-verdict + budget + evidence contract (sentinal-k8x1f.2/
  // .3/.4). These are TOP-LEVEL siblings of `state` on the execution-detail
  // response, camelCased by axiosTransport. `verdict` is SINGULAR — distinct
  // from the pre-existing plural `verdicts` (RunVerdict array) and the raw
  // `outcome` string, neither of which the adapter reads. All optional until
  // the backend deploy lands; consumed via services/verdictAdapter.ts.
  verdict?: { outcome?: string; reason?: string } | null;
  budget?: { maxSteps?: number; usedSteps?: number } | null;
  evidence?: { screenshot?: string; actionTrace?: any[] } | null;
  // Client-side marker set by pollExecution when the 10-min poll deadline is
  // hit — signals the handler to shape a partial 'timeout' result (bead 56kd.3)
  // instead of the service throwing and discarding evidence.
  timedOut?: boolean;
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
  findTemplateBySlug(slug: string): Promise<WorkflowTemplate | null>;
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
    async findTemplateBySlug(slug: string): Promise<WorkflowTemplate | null> {
      // Pure server-side slug resolve (bead 56kd.8). The backend does an EXACT
      // `?slug=` match server-side (contract sentinal-k8x1f.11) and returns
      // exactly that template, so this is a single GET — NO page-walk, NO
      // client-side name/slug filtering, NO name-substring fallback. A slug is
      // the stable template identity, so a backend rename can never break us.
      const response = await tx.get<{ results?: WorkflowTemplate[] }>(
        'api/v1/workflows/',
        { isTemplate: true, slug },
      );
      return response?.results?.[0] ?? null;
    },

    async findEvaluationTemplate(): Promise<WorkflowTemplate | null> {
      // Resolve the App Evaluation template purely by its stable slug.
      return service.findTemplateBySlug(getEvalTemplateSlug());
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
      let intervalMs = POLL_INTERVAL_INITIAL_MS;
      // Track the most recent observation so a poll-deadline timeout can return
      // partial results (screenshot + trace) instead of discarding them (bead
      // 56kd.3).
      let lastExecution: WorkflowExecution | undefined;
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          throw new Error(`Polling cancelled for execution ${executionUuid}`);
        }
        const execution = await service.getExecution(executionUuid);
        lastExecution = execution;
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
      // Deadline hit. Return the last observed execution flagged `timedOut` so
      // the handler shapes a partial 'timeout' result (bead 56kd.3) rather than
      // discarding the screenshot + trace we already captured. Only throw if we
      // never observed anything to shape.
      if (lastExecution) {
        Telemetry.capture(TelemetryEvents.WORKFLOW_EXECUTED, {
          status: lastExecution.status,
          success: false,
          outcome: 'timeout',
          stepsTaken: lastExecution.state?.stepsTaken ?? 0,
          durationMs: Date.now() - pollStart,
          pollCount,
          finalIntervalMs: intervalMs,
          timedOut: true,
        });
        return { ...lastExecution, timedOut: true };
      }
      throw new Error(
        `Execution ${executionUuid} timed out after ${EXECUTION_TIMEOUT_MS / 1000}s`
      );
    }
  };

  return service;
};
