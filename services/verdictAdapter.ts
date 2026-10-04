/**
 * Verdict adapter (bead 56kd.2).
 *
 * THE ONE place that maps the backend explicit-verdict + budget + evidence
 * contract onto the MCP relay fields. If the backend's final field shape
 * differs, re-align it here and nowhere else.
 *
 * Backend contract (camelCase after axiosTransport conversion). The containers
 * are TOP-LEVEL siblings of `state` on the execution-detail response:
 *   execution.verdict:  { outcome: pass|fail|error|null, reason, skipped? }
 *                       (outcome null + skipped: true = never attempted a test)
 *   execution.budget:   { maxSteps, usedSteps }
 *   execution.evidence: { screenshot, actionTrace }
 * `verdict` is SINGULAR — distinct from the pre-existing plural `verdicts`
 * (RunVerdict array) and the raw `outcome` string, neither of which we read.
 *
 * EVERY verdict a user sees is pass | fail | error (platform-98fv.16,
 * 2026-10-04). `inconclusive`, `unverified`, `unknown` and `abandoned` are gone
 * as user-facing values: they told a user nothing they could act on. They now
 * become `error` carrying the reason "No verdict recorded", which at least says
 * what happened.
 *
 * Principle: relay, never invent — but never relay a non-answer either.
 *   - pass/fail are relayed verbatim; everything else collapses to `error`.
 *   - nothing derived from the outcome is added beside it (no `success`, no
 *     `failureCategory`): a second copy of the verdict is a second thing to
 *     disagree with it.
 *   - the backend's own `reason` is shown whenever it sends one. We only
 *     supply a reason when it did not.
 *   - a missing / null / unrecognized verdict on a FINISHED run is `error`,
 *     never `fail`, never the raw execution status and never the raw run
 *     outcome (`state.outcome` is internal: it can be cancelled / timeout /
 *     skipped).
 *   - a run that NEVER ATTEMPTED A TEST has no verdict (platform-98fv.16): the
 *     backend sends `verdict: { outcome: null, reason, skipped: true }` and the
 *     relay is `outcome: null, skipped: true, skipReason: <reason verbatim>`.
 *   - a run still going has no verdict yet: `outcome: null`.
 *   - `budget` is the backend's container, relayed verbatim or not at all.
 *
 * `timeout` deserves its own note because it is OURS, not the backend's. The
 * MCP synthesises it when its own 10-minute poll deadline expires
 * (services/workflows.ts) — which is a different event from the backend saying
 * a run timed out. Both are `error`, because neither is a verdict about the
 * user's app, but the REASON keeps them apart: ours says we stopped waiting and
 * the run may still be going, theirs says whatever the backend said. Merging
 * them would erase the answer to the first question anyone asks.
 */

import type { WorkflowExecution } from './workflows.js';

/** The ONLY outcomes a user ever sees. */
export const USER_FACING_OUTCOMES = ['pass', 'fail', 'error'] as const;
export type VerdictOutcome = (typeof USER_FACING_OUTCOMES)[number];

/**
 * A reason is a FACTUAL RECORD: what we did, what we saw, what happened. No
 * hedges ("may", "likely"), no blame, no advice, and no fixed sentence per
 * category — a canned string reads as an explanation while carrying no
 * information, and the reader cannot tell one occurrence from another.
 *
 * So these are built from the actual values observed, and every number in them
 * is real.
 */
/**
 * THE mapping, exported because more than one field carries an outcome and they
 * must never disagree: the headline `outcome` and the nested
 * `evaluation.outcome` are read by the same person in the same payload. The
 * backend keeps them consistent by deriving both from one verdict
 * (sentinal-sk5sl.1); once the MCP re-maps one of them, it has to re-map the
 * other through the same function or it reintroduces exactly the contradiction
 * that design removed.
 */
export function toUserFacingOutcome(raw: unknown): VerdictOutcome {
  // Deliberately an allowlist, not a denylist of known non-answers: a value a
  // future backend invents must land on `error` too, rather than leaking
  // through because nobody added it to a list.
  const v = typeof raw === 'string' ? raw.trim() : '';
  return v === 'pass' || v === 'fail' ? v : 'error';
}

/**
 * An execution record as the executions tool relays it: the backend object
 * verbatim, except the three fields a user reads as the run's verdict —
 * `outcome`, `verdict.outcome`, `evaluation.outcome` — which go through the
 * same allowlist as check_app_in_browser. A null/absent outcome (a run still
 * going) stays null: "no verdict yet" is not an error. Internal run state
 * (`state.*`, node output) keeps its raw values.
 */
export function withUserFacingOutcomes<T>(execution: T): T {
  if (!execution || typeof execution !== 'object') return execution;
  const mapIfSet = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? toUserFacingOutcome(v) : v);
  const e: Record<string, any> = { ...(execution as Record<string, any>) };
  if ('outcome' in e) e.outcome = mapIfSet(e.outcome);
  for (const key of ['verdict', 'evaluation']) {
    if (e[key] && typeof e[key] === 'object' && 'outcome' in e[key]) {
      e[key] = { ...e[key], outcome: mapIfSet(e[key].outcome) };
    }
  }
  return e as T;
}

export function noVerdictReason(rawOutcome: unknown): string {
  const seen = typeof rawOutcome === 'string' && rawOutcome.trim() !== '' ? rawOutcome.trim() : null;
  return seen
    ? `Backend returned outcome '${seen}' with no reason.`
    : 'Backend returned no outcome and no reason.';
}

/** Facts the poll loop observed when its own deadline expired. */
export interface PollTimeoutFacts {
  executionUuid?: string;
  elapsedMs?: number;
  lastStatus?: string;
  pollCount?: number;
}

/**
 * OUR deadline expiring is not the backend reporting a timeout, and the two
 * must stay distinguishable: one means we stopped listening, the other means
 * the run stopped. This states only what we observed — no claim about whether
 * the run is still going, because we do not know.
 */
export function pollTimeoutReason(facts: PollTimeoutFacts): string {
  const parts: string[] = [];
  parts.push(
    facts.executionUuid
      ? `No result from execution ${facts.executionUuid}`
      : 'No result from the execution',
  );
  if (typeof facts.elapsedMs === 'number') {
    parts.push(`after ${Math.round(facts.elapsedMs / 1000)}s of polling`);
  }
  if (typeof facts.pollCount === 'number') {
    parts.push(`(${facts.pollCount} polls)`);
  }
  const head = parts.join(' ');
  return facts.lastStatus ? `${head}; last status: ${facts.lastStatus}.` : `${head}.`;
}

export interface RelayVerdict {
  /**
   * pass | fail | error — the backend verdict.outcome through toUserFacingOutcome.
   * null when the run never attempted a test (`skipped`) or has not finished.
   */
  outcome: VerdictOutcome | null;
  /** True when the backend says the run never attempted a test (no verdict). */
  skipped?: true;
  /** The backend's recorded reason the run never attempted a test, verbatim. */
  skipReason?: string;
  /** verdict.reason verbatim; an MCP-observed fact only when the backend sent none. */
  reason?: string;
  /**
   * The backend's `budget` container, relayed verbatim ({ maxSteps, usedSteps }).
   * Omitted when the backend sent none — the MCP does not invent a budget, and
   * does not restate it as stepsTaken / stepsBudget / stepsRemaining.
   */
  budget?: Record<string, unknown>;
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
  /**
   * Force the outcome (used by the poll-timeout path, bead 56kd.3, where there
   * is no terminal backend verdict to read).
   */
  outcomeOverride?: string;
  /**
   * What the poll loop observed when ITS deadline expired. Supplied only on
   * that path, and only used to build a factual reason — so our timeout can
   * never be mistaken for a backend-reported one.
   */
  pollTimeout?: PollTimeoutFacts;
}

/**
 * Map a workflow execution onto the MCP relay verdict. Never throws.
 */
export function adaptVerdict(
  execution: WorkflowExecution,
  opts: AdaptVerdictOptions = {},
): RelayVerdict {
  // Contract containers live at the TOP LEVEL of the execution response
  // (siblings of `state`), NOT nested under state.
  const verdict = execution?.verdict ?? null;
  const budget = execution?.budget ?? null;
  const evidence = execution?.evidence ?? null;

  // --- Outcome: pass | fail | error, or null for no verdict ---
  // Only the explicit verdict. NEVER the raw run outcome (state.outcome is the
  // run's internal record — cancelled / timeout / skipped) and never
  // execution.status.
  const rawOutcome = opts.outcomeOverride ?? verdict?.outcome;
  const raw = typeof rawOutcome === 'string' ? rawOutcome.trim() : '';
  const isOurPollTimeout = opts.outcomeOverride === 'timeout';
  const backendReason =
    typeof verdict?.reason === 'string' && verdict.reason.trim() !== '' ? verdict.reason : null;

  if (!isOurPollTimeout && !raw) {
    // A run that never attempted a test (platform-98fv.16): no verdict, and the
    // backend's recorded reason, verbatim.
    if (verdict?.skipped === true) {
      const skipped: RelayVerdict = { outcome: null, skipped: true };
      if (backendReason) skipped.skipReason = backendReason;
      if (budget && typeof budget === 'object') skipped.budget = budget;
      return attachEvidence(skipped, evidence);
    }
    // Still going: no verdict YET is not an error.
    if (!TERMINAL_STATUSES.has(String(execution?.status ?? ''))) {
      const pending: RelayVerdict = { outcome: null };
      if (budget && typeof budget === 'object') pending.budget = budget;
      return attachEvidence(pending, evidence);
    }
  }

  // error covers: the backend's own 'error'/'timeout', every retired non-answer
  // (inconclusive/unverified/unknown/abandoned), anything a newer backend
  // invents, and a verdict that never arrived.
  const outcome = toUserFacingOutcome(raw);

  const relay: RelayVerdict = { outcome };
  if (budget && typeof budget === 'object') relay.budget = budget;

  // Reason precedence, and the order is the whole point:
  //   1. the backend's own words, relayed VERBATIM and never rephrased;
  //   2. our poll deadline, stated as what we observed — only when WE forced
  //      the timeout, so a backend-reported timeout keeps its own reason;
  //   3. a factual record of what arrived, when nothing explained itself.
  // OUR deadline comes first, deliberately. If we never saw a terminal verdict,
  // any reason we are holding came from a mid-flight poll — it describes a run
  // still in progress, not its result. Relaying it next to outcome='error'
  // would pair someone else's "looks good" with our failure.
  if (isOurPollTimeout) {
    relay.reason = pollTimeoutReason({
      executionUuid: execution?.uuid,
      lastStatus: execution?.status,
      ...(opts.pollTimeout ?? {}),
    });
  } else if (backendReason) {
    relay.reason = backendReason;
  } else if (outcome === 'error') {
    relay.reason = noVerdictReason(raw);
  }
  return attachEvidence(relay, evidence);
}

/** The run lifecycle states after which no verdict will arrive. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** The backend's evidence container onto the relay, verbatim. */
function attachEvidence(relay: RelayVerdict, evidence: any): RelayVerdict {
  if (typeof evidence?.screenshot === 'string' && evidence.screenshot) relay.screenshot = evidence.screenshot;
  if (Array.isArray(evidence?.actionTrace)) relay.actionTrace = evidence.actionTrace;
  if (Array.isArray(evidence?.logins) && evidence.logins.length > 0) relay.logins = evidence.logins;
  if (evidence?.loginError && typeof evidence.loginError === 'object') {
    relay.loginError = evidence.loginError;
  }
  if (typeof evidence?.report === 'string' && evidence.report) relay.report = evidence.report;
  return relay;
}
