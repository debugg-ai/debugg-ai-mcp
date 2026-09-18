/**
 * Verdict adapter (bead 56kd.2).
 *
 * THE ONE place that maps the backend explicit-verdict + budget + evidence
 * contract onto the MCP relay fields. If the backend's final field shape
 * differs, re-align it here and nowhere else.
 *
 * Backend contract (camelCase after axiosTransport conversion). The containers
 * are TOP-LEVEL siblings of `state` on the execution-detail response:
 *   execution.verdict:  { outcome: pass|fail|inconclusive|error|timeout, reason }
 *   execution.budget:   { maxSteps, usedSteps }
 *   execution.evidence: { screenshot, actionTrace }
 * `verdict` is SINGULAR — distinct from the pre-existing plural `verdicts`
 * (RunVerdict array) and the raw `outcome` string, neither of which we read.
 *
 * Principle: relay, never invent.
 *   - `verdict.outcome` is relayed VERBATIM; `success` = (outcome === 'pass').
 *   - Anything else (fail/inconclusive/error/timeout) → success:false with
 *     `failureCategory = outcome` — NOT a fabricated 'assertion-mismatch'.
 *   - A missing / null / unrecognized verdict maps to `inconclusive`, never to
 *     `fail` and never to the raw execution status.
 *   - Budget comes from the response, not a client-side constant (the constant
 *     is only a fallback for pre-contract backends).
 */

import type { WorkflowExecution } from './workflows.js';

/** The verdict enum the backend emits (bead sentinal-k8x1f.2). */
export const KNOWN_OUTCOMES = ['pass', 'fail', 'inconclusive', 'error', 'timeout'] as const;
export type VerdictOutcome = (typeof KNOWN_OUTCOMES)[number];

const KNOWN = new Set<string>(KNOWN_OUTCOMES);

export interface RelayVerdict {
  /** Backend verdict.outcome, relayed verbatim; 'inconclusive' when absent/unknown. */
  outcome: string;
  /** Strictly (outcome === 'pass'). */
  success: boolean;
  /** = outcome when !success; omitted on success. */
  failureCategory?: string;
  /** Human-readable verdict.reason, when present. */
  reason?: string;
  /** budget.maxSteps (fallback: opts.fallbackBudget). */
  stepsBudget: number;
  /** budget.usedSteps (fallback: legacy state.stepsTaken, then 0). */
  stepsTaken: number;
  /** max(0, stepsBudget - stepsTaken). */
  stepsRemaining: number;
  /** evidence.screenshot, when present (URL or base64 — relayed as-is). */
  screenshot?: string;
  /** evidence.actionTrace, when present. */
  actionTrace?: any[];
  /**
   * evidence.logins — every login the run performed:
   * `{ username, source, submitted, authenticated, reason, detail }`, never a
   * password. `source` is where the credential came from: 'task' | 'explicit' |
   * 'credential_id' | 'env' | 'env_default'. Relayed VERBATIM (bead ymq2) —
   * never re-map it field by field, or a new backend field silently vanishes.
   */
  logins?: LoginRecord[];
  /**
   * evidence.loginError — the run named an account it could not resolve and
   * declined to substitute another. `{ reason, detail }`.
   */
  loginError?: { reason?: string; detail?: string };
  /**
   * evidence.report — the agent's own answer, for a run whose deliverable IS the
   * answer ("navigate and describe what you see").
   *
   * Distinct from `actionTrace[0].intent`, which is the RECONCILED reason: the
   * verify-gate rewrites it when the agent's claim contradicts page ground truth.
   * So on exactly the runs where the two diverge, reading the trace hands the
   * caller the gate's verdict instead of the answer it asked for.
   */
  report?: string;
}

/** One login the run performed. Passwords are never included. */
export interface LoginRecord {
  username?: string;
  source?: string;
  /** True only when credentials were actually typed and submitted. */
  submitted?: boolean;
  authenticated?: boolean;
  /** Machine-readable outcome, e.g. 'offscope_host', 'restored_session'. */
  reason?: string;
  /**
   * Human-readable, actionable explanation (sentinal-oj7dp.22) — e.g. which
   * host a login was refused on and how to authorize it.
   */
  detail?: string;
}

/** Credential sources that mean "the caller named this account for this run". */
const CALLER_SPECIFIED_SOURCES = new Set(['task', 'explicit', 'credential_id']);

/**
 * True when this login's credential CAME FROM the environment rather than a
 * named account. Says nothing about whether it was ever used — a refused
 * `offscope_host` skip carries an env source too. See credentialSubstitutions.
 */
export function isEnvironmentDefault(login: LoginRecord): boolean {
  return !!login.source && !CALLER_SPECIFIED_SOURCES.has(login.source);
}

/**
 * The logins that really did substitute an environment default for an account
 * the caller named (bead b5x6). All three must hold:
 *   - the credential came from the environment (isEnvironmentDefault);
 *   - it was actually submitted — a refused or skipped login typed nothing, so
 *     "signed in with an environment default" would be false (client runs
 *     2d4970a6, 146f081f);
 *   - it names an account, and not one the caller asked for — the environment's
 *     stored credential can BE the requested account, and a warning that lists
 *     X as both requested and used contradicts itself (client run 146f081f).
 * Identities compare trimmed and case-insensitively (they are emails).
 */
export function credentialSubstitutions(
  logins: LoginRecord[] | undefined,
  namedIdentities: Array<string | undefined>,
): LoginRecord[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const named = new Set(
    namedIdentities.filter((u): u is string => typeof u === 'string' && u.trim() !== '').map(norm),
  );
  return (logins ?? []).filter((l) =>
    isEnvironmentDefault(l)
    && l.submitted === true
    && typeof l.username === 'string' && l.username.trim() !== ''
    && !named.has(norm(l.username)),
  );
}

export interface AdaptVerdictOptions {
  /** Client-side step budget used only when the response carries no budget. */
  fallbackBudget?: number;
  /**
   * Force the outcome (used by the poll-timeout path, bead 56kd.3, where there
   * is no terminal backend verdict to read).
   */
  outcomeOverride?: string;
}

/**
 * Map a workflow execution onto the MCP relay verdict. Never throws.
 */
export function adaptVerdict(
  execution: WorkflowExecution,
  opts: AdaptVerdictOptions = {},
): RelayVerdict {
  const state = execution?.state ?? null;
  // Contract containers live at the TOP LEVEL of the execution response
  // (siblings of `state`), NOT nested under state.
  const verdict = execution?.verdict ?? null;
  const budget = execution?.budget ?? null;
  const evidence = execution?.evidence ?? null;

  // --- Outcome (verbatim relay, inconclusive on anything unrecognized) ---
  let outcome: string;
  if (opts.outcomeOverride) {
    outcome = opts.outcomeOverride;
  } else {
    // Prefer the explicit verdict; fall back to the legacy per-run outcome
    // field; NEVER fall back to execution.status. Unknown values → inconclusive.
    const raw = verdict?.outcome ?? state?.outcome;
    outcome = typeof raw === 'string' && KNOWN.has(raw) ? raw : 'inconclusive';
  }

  const success = outcome === 'pass';

  // --- Budget (from the response; constant is a fallback only) ---
  const fallbackBudget = opts.fallbackBudget ?? 0;
  const stepsBudget = typeof budget?.maxSteps === 'number' ? budget.maxSteps : fallbackBudget;
  const stepsTaken = typeof budget?.usedSteps === 'number'
    ? budget.usedSteps
    : (typeof state?.stepsTaken === 'number' ? state.stepsTaken : 0);
  const stepsRemaining = Math.max(0, stepsBudget - stepsTaken);

  const relay: RelayVerdict = {
    outcome,
    success,
    stepsBudget,
    stepsTaken,
    stepsRemaining,
  };

  if (!success) relay.failureCategory = outcome;
  if (typeof verdict?.reason === 'string' && verdict.reason) relay.reason = verdict.reason;
  if (typeof evidence?.screenshot === 'string' && evidence.screenshot) relay.screenshot = evidence.screenshot;
  if (Array.isArray(evidence?.actionTrace)) relay.actionTrace = evidence.actionTrace;
  if (Array.isArray(evidence?.logins) && evidence.logins.length > 0) relay.logins = evidence.logins;
  if (evidence?.loginError && typeof evidence.loginError === 'object') {
    relay.loginError = evidence.loginError;
  }
  if (typeof evidence?.report === 'string' && evidence.report) relay.report = evidence.report;

  return relay;
}
