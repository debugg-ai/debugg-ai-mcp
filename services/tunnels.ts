/**
 * Tunnels Service
 * Provisions short-lived ngrok keys for MCP-managed tunnel setup.
 * Called before executeWorkflow so the tunnel URL is known before execution starts.
 */

import { AxiosTransport } from '../utils/axiosTransport.js';
import { Telemetry, TelemetryEvents } from '../utils/telemetry.js';

export interface TunnelProvision {
  tunnelId: string;
  tunnelKey: string;
  keyId: string;
  expiresAt: string;
}

export interface ProvisionRetryOptions {
  purpose?: string;
  /** Max attempts INCLUDING the first try. Default 3. */
  maxAttempts?: number;
  /** Sleep durations in ms between attempts. Default [500, 1500, 3000] capped at maxAttempts-1 entries. */
  backoffMs?: number[];
  /** Injectable sleep — test hook. */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface TunnelsService {
  provision(purpose?: string): Promise<TunnelProvision>;
  /**
   * Provision with automatic retry on transient failures (bead 7nx).
   * Retries only when the classified error has retryable:true (5xx, 408, 429,
   * network errors). 4xx auth/quota errors fail fast to avoid loops.
   */
  provisionWithRetry(opts?: ProvisionRetryOptions): Promise<TunnelProvision>;
}

/**
 * Typed error thrown by provision() when the backend/ngrok path fails.
 * Carries diagnostic fields a retry wrapper (bead 7nx) can use to decide
 * whether to retry, and that handler error messages can surface so users
 * have something actionable to file bug reports against.
 */
export class TunnelProvisionError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly networkCode: string | undefined;
  readonly retryable: boolean;

  constructor(opts: {
    message: string;
    status?: number;
    code?: string;
    requestId?: string;
    networkCode?: string;
    retryable: boolean;
  }) {
    super(opts.message);
    this.name = 'TunnelProvisionError';
    this.status = opts.status;
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.networkCode = opts.networkCode;
    this.retryable = opts.retryable;
  }

  /**
   * Stable one-line suffix for user-facing error messages.
   * Example: '(status: 503, request-id: abc123, retryable)' or '(network: ECONNRESET, retryable)'.
   */
  diagnosticSuffix(): string {
    const parts: string[] = [];
    if (this.status != null) parts.push(`status: ${this.status}`);
    if (this.code) parts.push(`code: ${this.code}`);
    if (this.requestId) parts.push(`request-id: ${this.requestId}`);
    if (this.networkCode) parts.push(`network: ${this.networkCode}`);
    parts.push(this.retryable ? 'retryable' : 'not-retryable');
    return `(${parts.join(', ')})`;
  }
}

/**
 * Classify an axios-interceptor-rewritten error (or any thrown Error) into a
 * TunnelProvisionError with retryable semantics. Called from provision().
 *
 * Retryable: 5xx, 408 (request timeout), 429 (rate limit), and any network
 * error (no response received — ECONNRESET / ECONNREFUSED / timeout).
 * Not retryable: 4xx other than 408/429 — those indicate auth/quota/input
 * problems that won't self-heal on the same API key.
 */
export function classifyProvisionError(err: unknown): TunnelProvisionError {
  const e = err as any;
  const message = e?.message ? String(e.message) : 'Tunnel provisioning failed';
  const status: number | undefined = typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  const data = e?.responseData;
  const code: string | undefined =
    data && typeof data === 'object' && typeof data.code === 'string' ? data.code : undefined;
  const headers = e?.responseHeaders;
  const requestId: string | undefined =
    headers && typeof headers === 'object'
      ? ((headers['x-request-id'] || headers['X-Request-Id']) ?? undefined)
      : undefined;
  const networkCode: string | undefined = typeof e?.networkCode === 'string' ? e.networkCode : undefined;

  let retryable: boolean;
  if (status == null) {
    retryable = true;
  } else if (status >= 500) {
    retryable = true;
  } else if (status === 408 || status === 429) {
    retryable = true;
  } else {
    retryable = false;
  }

  return new TunnelProvisionError({ message, status, code, requestId, networkCode, retryable });
}

const DEFAULT_BACKOFF_MS = [500, 1500, 3000];
const DEFAULT_MAX_ATTEMPTS = 3;

export const createTunnelsService = (tx: AxiosTransport): TunnelsService => {
  async function provision(purpose = 'workflow'): Promise<TunnelProvision> {
    let response;
    try {
      response = await tx.post<{
        tunnelId: string;
        tunnelKey: string;
        keyId: string;
        expiresAt: string;
      }>('api/v1/tunnels/', { purpose });
    } catch (err) {
      throw classifyProvisionError(err);
    }

    if (!response?.tunnelId || !response?.tunnelKey) {
      throw new TunnelProvisionError({
        message: 'Tunnel provisioning returned a success response missing tunnelId or tunnelKey',
        retryable: false,
      });
    }

    return {
      tunnelId: response.tunnelId,
      tunnelKey: response.tunnelKey,
      keyId: response.keyId,
      expiresAt: response.expiresAt,
    };
  }

  async function provisionWithRetry(opts: ProvisionRetryOptions = {}): Promise<TunnelProvision> {
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    const sleep = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    let lastErr: TunnelProvisionError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await provision(opts.purpose);
        if (attempt > 1) {
          Telemetry.capture(TelemetryEvents.TUNNEL_PROVISION_RETRY, {
            attempt,
            outcome: 'success',
          });
        }
        return result;
      } catch (err) {
        const e = err instanceof TunnelProvisionError ? err : classifyProvisionError(err);
        lastErr = e;
        const isLastAttempt = attempt >= maxAttempts;
        const willRetry = e.retryable && !isLastAttempt;

        Telemetry.capture(TelemetryEvents.TUNNEL_PROVISION_RETRY, {
          attempt,
          outcome: willRetry ? 'will-retry' : 'giving-up',
          status: e.status,
          code: e.code,
          requestId: e.requestId,
          networkCode: e.networkCode,
          retryable: e.retryable,
        });

        if (!willRetry) throw e;

        const waitMs = backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 0;
        await sleep(waitMs);
      }
    }
    // Unreachable in practice — loop always returns or throws.
    throw lastErr ?? new TunnelProvisionError({
      message: 'provisionWithRetry exhausted attempts without a classified error',
      retryable: false,
    });
  }

  return { provision, provisionWithRetry };
};
