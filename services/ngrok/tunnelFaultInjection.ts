/**
 * Fault injection + trace collection for tunnel lifecycle debugging (bead 42g).
 *
 * This is a TEST/DEV harness. Activation requires BOTH:
 *   - NODE_ENV !== 'production'
 *   - DEBUGG_TUNNEL_FAULT_MODE env var explicitly set
 *
 * Modes (comma-separated, parseable by parseFaultMode):
 *   fail-connect-N:<count>     — fail the first <count> ngrok.connect() attempts
 *   empty-url-N:<count>         — return empty URL from first <count> connect() attempts
 *   delay-connect:<ms>          — sleep <ms> before each connect() call
 *
 * Examples:
 *   DEBUGG_TUNNEL_FAULT_MODE=fail-connect-N:2
 *   DEBUGG_TUNNEL_FAULT_MODE=delay-connect:2000,fail-connect-N:1
 */

export type FaultMode = {
  failConnectN?: number;
  emptyUrlN?: number;
  delayConnectMs?: number;
};

export function parseFaultMode(raw: string | undefined): FaultMode | null {
  if (!raw) return null;
  const mode: FaultMode = {};
  for (const token of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = token.match(/^(fail-connect-N|empty-url-N|delay-connect):(\d+)$/);
    if (!m) continue;
    const [, name, valStr] = m;
    const val = parseInt(valStr, 10);
    if (name === 'fail-connect-N') mode.failConnectN = val;
    else if (name === 'empty-url-N') mode.emptyUrlN = val;
    else if (name === 'delay-connect') mode.delayConnectMs = val;
  }
  return Object.keys(mode).length > 0 ? mode : null;
}

export function getFaultModeFromEnv(): FaultMode | null {
  if (process.env.NODE_ENV === 'production') return null;
  return parseFaultMode(process.env.DEBUGG_TUNNEL_FAULT_MODE);
}

/**
 * Per-call, mutable fault-injection state. Tracks remaining fault counts so
 * a 'fail first N' mode applies to the first N attempts within one call, not
 * forever.
 */
export class FaultInjector {
  private failConnectRemaining: number;
  private emptyUrlRemaining: number;
  private readonly delayMs: number;

  constructor(mode: FaultMode | null | undefined) {
    this.failConnectRemaining = mode?.failConnectN ?? 0;
    this.emptyUrlRemaining = mode?.emptyUrlN ?? 0;
    this.delayMs = mode?.delayConnectMs ?? 0;
  }

  /** Returns true if this attempt should be forced to fail. Consumes the counter. */
  shouldFailConnect(): boolean {
    if (this.failConnectRemaining > 0) {
      this.failConnectRemaining -= 1;
      return true;
    }
    return false;
  }

  /** Returns true if this attempt should return an empty URL. Consumes the counter. */
  shouldReturnEmptyUrl(): boolean {
    if (this.emptyUrlRemaining > 0) {
      this.emptyUrlRemaining -= 1;
      return true;
    }
    return false;
  }

  delayMsForAttempt(): number {
    return this.delayMs;
  }

  /** For diagnostic logging — what's left after in-flight consumption. */
  snapshot(): { failConnectRemaining: number; emptyUrlRemaining: number; delayMs: number } {
    return {
      failConnectRemaining: this.failConnectRemaining,
      emptyUrlRemaining: this.emptyUrlRemaining,
      delayMs: this.delayMs,
    };
  }
}

// ─ Trace collector ────────────────────────────────────────────────────────────
//
// Collects timestamped events across a single tunnel-create call so that when
// real failures happen in production, an artifact dump gives the deep-dive
// agent (bead 7qh) the exact elapsed-time breakdown of each layer.

export interface TraceEvent {
  timestamp: number;
  elapsedMs: number;
  event: string;
  context?: Record<string, unknown>;
}

export class TunnelTrace {
  private readonly startTime: number;
  private readonly events: TraceEvent[] = [];

  constructor(startTime: number = Date.now()) {
    this.startTime = startTime;
  }

  emit(event: string, context?: Record<string, unknown>): void {
    const now = Date.now();
    this.events.push({
      timestamp: now,
      elapsedMs: now - this.startTime,
      event,
      context,
    });
  }

  toJSON(): { startTime: number; durationMs: number; events: TraceEvent[] } {
    const last = this.events[this.events.length - 1];
    return {
      startTime: this.startTime,
      durationMs: last ? last.elapsedMs : 0,
      events: this.events,
    };
  }

  /** Human-readable one-line-per-event dump, newest last. */
  format(): string {
    return this.events
      .map((e) => {
        const ctx = e.context ? ' ' + JSON.stringify(e.context) : '';
        return `+${e.elapsedMs.toString().padStart(6)}ms  ${e.event}${ctx}`;
      })
      .join('\n');
  }
}
