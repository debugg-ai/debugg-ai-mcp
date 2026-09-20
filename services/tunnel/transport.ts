/**
 * TunnelTransport — the boundary between tunnel LIFECYCLE (tunnelManager.ts:
 * who owns a tunnel, when it is reused, when it is torn down) and tunnel
 * TRANSPORT (debuggTransport.ts: the websocket mux that actually carries
 * bytes).
 *
 * This started life as a two-implementation seam so the ngrok client and the
 * debugg client could run side by side through the rollout. ngrok is gone and
 * there is exactly one implementation now, but the interface is KEPT and the
 * two-implementation machinery around it is not — see the note below.
 *
 * WHY KEEP AN INTERFACE WITH ONE IMPLEMENTATION: it is the injection point
 * (`tunnelManager.transport`) every tunnel-lifecycle test drives, in the same
 * spirit as `caddyFactory`. Without it, testing eviction, the retry ladder or
 * the idle timer means standing up a real websocket against a real relay.
 * It also keeps debuggTransport's ~600 lines of framing, flow control and
 * reconnect out of TunnelManager, which is the reason the file boundary is
 * worth having regardless of how many implementations exist.
 *
 * WHAT WAS REMOVED WITH ngrok, because it was ceremony the moment the second
 * implementation went away:
 *   - `TunnelTransportKind` and the `Record<kind, TunnelTransport>` registry —
 *     a map with one key, keyed by a union with one member.
 *   - `prepare()`, `resetAfterFailedAttempt()` and `onAllTunnelsStopped()` —
 *     three optional hooks that existed ONLY for the ngrok agent process
 *     (pre-warm, agent reset between retries, module reset when the agent may
 *     have exited). debugg has no out-of-process agent, so every one of them
 *     was a no-op on the only surviving implementation.
 *
 * Everything above this seam is unchanged: handlers, utils/tunnelContext.ts,
 * the per-session Caddy instance, PortLock, URL rewriting, the retry ladder and
 * the idle timer (docs/debugg-tunnel-server-design-2026-09-19.md §5).
 */

import type { ProbeResult } from './protocol/index.js';

/**
 * The parts of a provision response that a connect needs. A `TunnelProvision`
 * satisfies this structurally, so callers pass the provision itself.
 */
export interface TunnelTransportSelection {
  /** The websocket control endpoint, e.g. wss://api.debugg.ai/tunnel/v1/connect */
  relayUrl?: string;
  /** The hostname suffix, e.g. tunnel.debugg.ai */
  tunnelDomain?: string;
  /**
   * The id the backend issued. BOTH tunnel paths must use it: the token is
   * bound to that Tunnel record, so a client-minted uuid is rejected with 401.
   */
  tunnelId?: string;
}

export interface TunnelConnectOptions {
  /** The hostname label, sent as X-Debugg-Tunnel-Id and bound to the token. */
  tunnelId: string;
  /** Where the control websocket goes. */
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
  /**
   * Short label for logs and telemetry. Kept as a property rather than
   * hardcoded at the call sites so the `transport` dimension on
   * TUNNEL_PROVISIONED / TUNNEL_STOPPED stays populated and keeps its meaning
   * if a second transport ever arrives.
   */
  readonly kind: string;

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
   * Health-check the tunnel from the server side (a control-channel PROBE).
   * A tunnel hostname resolves only inside our VPC, so this is the only way to
   * health-check one from a user's machine.
   */
  probe?(publicUrl: string, path: string, opts?: { timeoutMs?: number }): Promise<ProbeResult>;
}
