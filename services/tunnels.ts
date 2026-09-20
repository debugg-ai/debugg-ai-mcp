/**
 * Tunnels Service
 * Provisions short-lived ngrok keys for MCP-managed tunnel setup.
 * Called before executeWorkflow so the tunnel URL is known before execution starts.
 */

import { AxiosTransport } from '../utils/axiosTransport.js';
import { Telemetry, TelemetryEvents } from '../utils/telemetry.js';
import {
  isValidTunnelDomain,
  registerTunnelDomain,
  type TunnelTransportKind,
} from '../utils/tunnelDomains.js';

export interface TunnelProvision {
  tunnelId: string;
  tunnelKey: string;
  keyId: string;
  expiresAt: string;
  /**
   * Which tunnel client to use. The backend picks it per request behind a flag,
   * so rollout and rollback need no MCP release. A response with no `transport`
   * is an OLD BACKEND and means ngrok — that default is what keeps a new client
   * working against a backend that has never heard of this field.
   */
  transport: TunnelTransportKind;
  /** debugg only: the control websocket endpoint. */
  relayUrl?: string;
  /** debugg only: the hostname suffix the tunnel is served on. */
  tunnelDomain?: string;
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
   * Revoke a provisioned tunnel through the endpoint its transport uses:
   * ngrok keys through `api/v1/ngrok/revoke/`, debugg tunnels through
   * `api/v1/tunnels/<tunnelId>/revoke/`. Call sites do not have to know which.
   */
  revoke(provision: Pick<TunnelProvision, 'tunnelId' | 'keyId' | 'transport'>): Promise<void>;
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

/** The transports this client can actually drive, best first. */
export const SUPPORTED_TRANSPORTS: readonly TunnelTransportKind[] = Object.freeze(['debugg', 'ngrok']);

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

    // No `transport` means an old backend that predates negotiation, which only
    // ever hands out ngrok keys.
    const transport = (response.transport ?? 'ngrok') as TunnelTransportKind;
    if (!SUPPORTED_TRANSPORTS.includes(transport)) {
      throw new TunnelProvisionError({
        message:
          `Tunnel provisioning selected transport "${response.transport}", which this client cannot speak ` +
          `(it offered ${SUPPORTED_TRANSPORTS.join(', ')}). Update @debugg-ai/debugg-ai-mcp.`,
        retryable: false,
      });
    }

    const result: TunnelProvision = {
      tunnelId: response.tunnelId,
      tunnelKey: response.tunnelKey,
      keyId: response.keyId,
      expiresAt: response.expiresAt,
      transport,
    };

    if (transport === 'debugg') {
      // Every one of these is non-retryable: retrying cannot turn a malformed
      // response into a usable one, and TunnelManager must never be handed a
      // debugg token with nowhere to send it.
      if (!response.relayUrl || !response.tunnelDomain) {
        throw new TunnelProvisionError({
          message: 'Tunnel provisioning selected the debugg transport but omitted relayUrl or tunnelDomain',
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
      registerTunnelDomain(response.tunnelDomain, 'debugg');
      result.relayUrl = response.relayUrl;
      result.tunnelDomain = response.tunnelDomain;
    }

    return result;
  }

  async function revoke(
    provisionInfo: Pick<TunnelProvision, 'tunnelId' | 'keyId' | 'transport'>,
  ): Promise<void> {
    if (provisionInfo.transport === 'debugg') {
      await tx.post(`api/v1/tunnels/${provisionInfo.tunnelId}/revoke/`, {});
      return;
    }
    await tx.post('api/v1/ngrok/revoke/', { ngrokKeyId: provisionInfo.keyId });
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
