/**
 * Detect well-known transient failure signatures in completed workflow
 * executions. When `isTransientWorkflowError` returns true, the MCP handler
 * auto-retries the workflow (cost: one extra quota unit) — saving the caller
 * from the 'pure infrastructure noise' failure mode the original client
 * called out in their feedback (Pydantic JSON parse errors, etc.).
 *
 * Be CONSERVATIVE: only patterns documented as transient. False positives
 * waste quota; false negatives leave existing behavior, which is fine — the
 * caller still gets a clear error and can decide what to do.
 *
 * Bead `kbxy`. Patterns are extracted (not inlined) so they're easy to audit
 * + extend as new transient signatures get observed in production.
 */

import type { WorkflowExecution } from '../services/workflows.js';

/**
 * Patterns that match transient backend failures worth retrying. Each entry
 * is a regex tested against `errorMessage` AND `state.error`. Matching ANY
 * pattern in EITHER field flags the execution as transient.
 *
 * To add a new pattern: confirm by sampling production telemetry that the
 * signature recovers on retry (a one-shot reproduce-then-retry test is
 * sufficient evidence). Document the source in the comment.
 */
const TRANSIENT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // The original client complaint. Backend agent's brain.step occasionally
  // returns malformed JSON for the structured output — Pydantic chokes on
  // EOF / partial JSON. A fresh agent invocation reliably recovers.
  { pattern: /Invalid JSON.*EOF while parsing/i, reason: 'pydantic-eof' },
  { pattern: /Failed to parse AgentOutput/i, reason: 'agent-output-parse' },

  // Backend-side infrastructure flakes (nginx 502 from upstream + timeouts).
  // Both observed in production during 2026-04-26 + 2026-04-27 deploys —
  // recovery on next request is the rule, not the exception.
  { pattern: /502 Bad Gateway/i, reason: 'nginx-502' },
  { pattern: /upstream connect timeout/i, reason: 'upstream-timeout' },

  // Network-layer transient — TCP reset between MCP↔backend or backend↔model.
  { pattern: /ECONNRESET|connection reset by peer/i, reason: 'econnreset' },
];

/**
 * @returns true if the execution's error fields contain a known transient
 * signature, indicating a retry has a reasonable chance of succeeding.
 */
export function isTransientWorkflowError(execution: WorkflowExecution | null | undefined): boolean {
  if (!execution) return false;

  const candidates: string[] = [];
  if (typeof execution.errorMessage === 'string' && execution.errorMessage) {
    candidates.push(execution.errorMessage);
  }
  if (typeof execution.state?.error === 'string' && execution.state.error) {
    candidates.push(execution.state.error);
  }
  if (candidates.length === 0) return false;

  for (const text of candidates) {
    for (const { pattern } of TRANSIENT_PATTERNS) {
      if (pattern.test(text)) return true;
    }
  }
  return false;
}

/**
 * @returns the reason tag for the matched transient pattern (for telemetry),
 *   or undefined if no pattern matched. Useful when you want to attach a
 *   classifier to a `workflow.transient_retry` event.
 */
export function transientReasonTag(execution: WorkflowExecution | null | undefined): string | undefined {
  if (!execution) return undefined;
  const fields: string[] = [];
  if (typeof execution.errorMessage === 'string' && execution.errorMessage) fields.push(execution.errorMessage);
  if (typeof execution.state?.error === 'string' && execution.state.error) fields.push(execution.state.error);
  for (const text of fields) {
    for (const { pattern, reason } of TRANSIENT_PATTERNS) {
      if (pattern.test(text)) return reason;
    }
  }
  return undefined;
}
