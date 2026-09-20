/**
 * TunnelTransport — the one step of tunnel creation that differs between ngrok
 * and the debugg tunnel server.
 *
 * STUB (bead debugg_ai_mcp-xkoh.5.3, phase 2.1). Types and signatures only; the
 * implementations arrive in phase 4.1 (debugg_ai_mcp-xkoh.5.7).
 *
 * Everything above this seam is unchanged: handlers, utils/tunnelContext.ts,
 * the per-session Caddy instance, PortLock, URL rewriting, the retry ladder,
 * the idle timer and the session keying all behave exactly as they do today
 * (docs/debugg-tunnel-server-design-2026-09-19.md §5). TunnelManager picks an
 * implementation from the provision response and calls it where it calls
 * ngrok.connect() today.
 */

import type { ProbeResult } from './protocol/index.js';

/** Which tunnel the backend told us to use. A response with no `transport` means ngrok. */
export type TunnelTransportKind = 'ngrok' | 'debugg';

/**
 * The transport-selecting part of a provision response. A `TunnelProvision`
 * satisfies this structurally, so callers pass the provision itself.
 */
export interface TunnelTransportSelection {
  transport: TunnelTransportKind;
  /** debugg only: the websocket control endpoint, e.g. wss://api.debugg.ai/tunnel/v1/connect */
  relayUrl?: string;
  /** debugg only: the hostname suffix, e.g. tunnel.debugg.ai */
  tunnelDomain?: string;
  /**
   * The id the backend issued. The dedicated (test_suite run) path must use it
   * for a debugg tunnel: the token is bound to that Tunnel record, so a
   * client-minted uuid is rejected with 401.
   */
  tunnelId?: string;
}

export interface TunnelConnectOptions {
  /** The hostname label, sent as X-Debugg-Tunnel-Id and bound to the token. */
  tunnelId: string;
  /** debugg only: where the control websocket goes. */
  relayUrl?: string;
  /**
   * Called when the tunnel can never come back — a revoke, or an auth failure
   * on reconnect. TunnelManager evicts the tunnel so the next call
   * re-provisions instead of reusing a corpse.
   */
  onDead?: (reason: string) => void;
}

/**
 * An error a transport throws out of connect(). `retryable: false` stops the
 * retry ladder immediately, for the cases where looping cannot help: 401
 * (bad/expired/revoked key), 400 (bad tunnel id) and 426 (this client is too
 * old for the server).
 */
export interface TunnelTransportError extends Error {
  retryable?: boolean;
}

export interface TunnelTransport {
  readonly kind: TunnelTransportKind;

  /**
   * Establish the tunnel and return its public origin (no path).
   *
   * `localAddr` is the ONLY address this tunnel may ever dial. It is Caddy's
   * loopback origin for a session tunnel, or the app itself for the dedicated
   * test_suite path (`127.0.0.1:<p>`, `host.docker.internal:<p>`,
   * `https://localhost:<p>`, `https://host.docker.internal:<p>`).
   */
  connect(
    localAddr: string,
    hostname: string,
    token: string,
    opts: TunnelConnectOptions,
  ): Promise<string>;

  /** Tear the tunnel down. Must not reconnect afterwards. */
  disconnect(publicUrl: string): Promise<void>;

  /**
   * Health-check the tunnel from the server side (debugg: a control-channel
   * PROBE). Absent on transports whose public URL can simply be fetched.
   */
  probe?(publicUrl: string, path: string, opts?: { timeoutMs?: number }): Promise<ProbeResult>;

  /** ngrok only: pre-warm the agent session before the first connect (bead pqgj). */
  prepare?(token: string): Promise<void>;

  /** ngrok only: the agent reset the retry ladder does between attempts 1 and 2. */
  resetAfterFailedAttempt?(): Promise<void>;

  /** ngrok only: no tunnels of this kind remain, so the agent module can be reset. */
  onAllTunnelsStopped?(): void;
}
