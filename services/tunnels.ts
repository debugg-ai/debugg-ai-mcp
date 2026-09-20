/**
 * Tunnels Service
 * Provisions short-lived debugg tunnel tokens for MCP-managed tunnel setup.
 * Called before executeWorkflow so the tunnel URL is known before execution starts.
 */

import { AxiosTransport } from '../utils/axiosTransport.js';
import { Telemetry, TelemetryEvents } from '../utils/telemetry.js';
import {
  isValidTunnelDomain,
  registerTunnelDomain,
} from '../utils/tunnelDomains.js';

export interface TunnelProvision {
  tunnelId: string;
  tunnelKey: string;
  /** The backend's `Tunnel.id` for this provision. */
  keyId: string;
  expiresAt: string;
  /** The control websocket endpoint. */
  relayUrl: string;
  /** The hostname suffix the tunnel is served on. */
  tunnelDomain: string;
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
  /** Revoke a provisioned tunnel through `api/v1/tunnels/<tunnelId>/revoke/`. */
  revoke(provision: Pick<TunnelProvision, 'tunnelId'>): Promise<void>;
  /**
   * Provision with automatic retry on transient failures (bead 7nx).
   * Retries only when the classified error has retryable:true (5xx, 408, 429,
   * network errors). 4xx auth/quota errors fail fast to avoid loops.
   */
  provisionWithRetry(opts?: ProvisionRetryOptions): Promise<TunnelProvision>;
}

/**
 * Typed error thrown by provision() when the backend tunnel path fails.
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

/**
 * The transports this client can actually drive.
 *
 * KEEP SENDING THIS, even though it is now a list of one. The backend's
 * negotiation treats a request that offers NOTHING as a pre-negotiation client
 * and hands it ngrok (design §2), which this client can no longer speak. An
 * empty or absent `transports` is therefore not a simplification — it is how
 * you get handed a tunnel you cannot connect to.
 */
export const SUPPORTED_TRANSPORTS: readonly string[] = Object.freeze(['debugg']);

/** A relay URL must be wss, except against a loopback backend (local dev, tests). */
function isAcceptableRelayUrl(relayUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'wss:') return true;
  if (url.protocol !== 'ws:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export const createTunnelsService = (tx: AxiosTransport): TunnelsService => {
  async function provision(purpose = 'workflow'): Promise<TunnelProvision> {
    let response;
    try {
      response = await tx.post<{
        tunnelId: string;
        tunnelKey: string;
        keyId: string;
        expiresAt: string;
        transport?: string;
        relayUrl?: string;
        tunnelDomain?: string;
      }>('api/v1/tunnels/', { purpose, transports: [...SUPPORTED_TRANSPORTS] });
    } catch (err) {
      throw classifyProvisionError(err);
    }

    if (!response?.tunnelId || !response?.tunnelKey) {
      throw new TunnelProvisionError({
        message: 'Tunnel provisioning returned a success response missing tunnelId or tunnelKey',
        retryable: false,
      });
    }

    // Every failure below is non-retryable: retrying cannot turn a response
    // this client cannot use into one it can, and TunnelManager must never be
    // handed a token with nowhere to send it.
    //
    // The backend still negotiates, so it can still answer "ngrok" — to a
    // client that no longer has an ngrok transport to answer with. That is a
    // version mismatch, and it gets its own message rather than a generic
    // "unsupported transport", because it is the only thing the user will see
    // and the fix is a specific one.
    if (response.transport === 'ngrok') {
      throw new TunnelProvisionError({
        message:
          'Tunnel provisioning selected the ngrok transport, which this version of ' +
          '@debugg-ai/debugg-ai-mcp no longer implements (it offered: ' +
          `${SUPPORTED_TRANSPORTS.join(', ')}). Either the backend has not been moved off ngrok yet, ` +
          'or this account is still pinned to it. Pin @debugg-ai/debugg-ai-mcp@4.4.1 until the ' +
          'backend serves debugg tunnels.',
        retryable: false,
      });
    }
    if (response.transport !== undefined && !SUPPORTED_TRANSPORTS.includes(response.transport)) {
      throw new TunnelProvisionError({
        message:
          `Tunnel provisioning selected transport "${response.transport}", which this client cannot speak ` +
          `(it offered ${SUPPORTED_TRANSPORTS.join(', ')}). Update @debugg-ai/debugg-ai-mcp.`,
        retryable: false,
      });
    }
    // A response with no `transport` at all predates negotiation entirely. It
    // is only usable if it is self-describing — i.e. it carries the debugg
    // fields anyway. Otherwise it is an ngrok provision in all but name.
    if (!response.relayUrl || !response.tunnelDomain) {
      throw new TunnelProvisionError({
        message:
          'Tunnel provisioning returned no relayUrl/tunnelDomain, so there is no debugg tunnel to ' +
          'connect to. This backend predates the debugg tunnel server; pin ' +
          '@debugg-ai/debugg-ai-mcp@4.4.1 until it is upgraded.',
        retryable: false,
      });
    }
    if (!isAcceptableRelayUrl(response.relayUrl)) {
      throw new TunnelProvisionError({
        message:
          `Tunnel provisioning returned a relayUrl that is not wss (${response.relayUrl}); ` +
          'refusing to send the tunnel key over it',
        retryable: false,
      });
    }
    if (!isValidTunnelDomain(response.tunnelDomain)) {
      throw new TunnelProvisionError({
        message: `Tunnel provisioning returned an unusable tunnelDomain (${response.tunnelDomain})`,
        retryable: false,
      });
    }
    // Registering it here is what stops a tunnel URL leaking: everything that
    // recognises or rewrites a tunnel hostname reads this same registry, so a
    // domain the backend moves to is covered the moment it is handed to us.
    registerTunnelDomain(response.tunnelDomain);

    return {
      tunnelId: response.tunnelId,
      tunnelKey: response.tunnelKey,
      keyId: response.keyId,
      expiresAt: response.expiresAt,
      relayUrl: response.relayUrl,
      tunnelDomain: response.tunnelDomain,
    };
  }

  async function revoke(provisionInfo: Pick<TunnelProvision, 'tunnelId'>): Promise<void> {
    await tx.post(`api/v1/tunnels/${provisionInfo.tunnelId}/revoke/`, {});
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

  return { provision, provisionWithRetry, revoke };
};
