/**
 * Generic telemetry abstraction layer.
 * Providers implement TelemetryProvider; call sites use Telemetry.capture().
 * Falls back to NoopProvider when no provider is configured.
 */

import { createHash } from 'crypto';

export interface TelemetryEvent {
  event: string;
  distinctId: string;
  properties?: Record<string, any>;
  timestamp?: Date;
}

export interface TelemetryProvider {
  capture(event: TelemetryEvent): void;
  identify(distinctId: string, properties?: Record<string, any>): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

class NoopProvider implements TelemetryProvider {
  capture(_event: TelemetryEvent): void {}
  identify(_distinctId: string, _properties?: Record<string, any>): void {}
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

let _provider: TelemetryProvider = new NoopProvider();
let _distinctId = 'anonymous';

export const Telemetry = {
  configure(provider: TelemetryProvider): void {
    _provider = provider;
  },

  /**
   * Derive a stable, anonymous identifier from the API key.
   * Uses SHA-256 so the raw key is never stored or transmitted.
   */
  setDistinctId(apiKey: string): void {
    _distinctId = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  },

  capture(event: string, properties?: Record<string, any>): void {
    try {
      _provider.capture({ event, distinctId: _distinctId, properties, timestamp: new Date() });
    } catch {
      // never let telemetry crash the app
    }
  },

  async flush(): Promise<void> {
    try {
      await _provider.flush();
    } catch {
      // best-effort
    }
  },

  async shutdown(): Promise<void> {
    try {
      await _provider.shutdown();
    } catch {
      // best-effort
    }
  },
};

export const TelemetryEvents = {
  TOOL_EXECUTED: 'tool.executed',
  TOOL_FAILED: 'tool.failed',
  WORKFLOW_EXECUTED: 'workflow.executed',
  WORKFLOW_TRANSIENT_RETRY: 'workflow.transient_retry',
  TUNNEL_PROVISIONED: 'tunnel.provisioned',
  TUNNEL_PROVISION_RETRY: 'tunnel.provision_retry',
  TUNNEL_STOPPED: 'tunnel.stopped',
  // services/ngrok/tunnelManager.ts — the session tunnel's Caddy instance
  // crash-respawned onto a DIFFERENT local proxy port (sticky-port reclaim
  // failed). The existing ngrok tunnel is now dialing a dead port, so the
  // whole session tunnel is evicted and must be recreated on the next call
  // (see docs/local-tunnel-multiplexer-architecture-2026-07-31.md §2.3).
  TUNNEL_EVICTED_PORT_CHANGED: 'tunnel.evicted_port_changed',
  // services/ngrok/tunnelManager.ts — stopTunnel()'s unconditional-removal
  // contract (§2.3): map state is always removed before cleanup I/O runs, so
  // a partial failure here (ngrok disconnect / caddy.stop() / key revoke)
  // never leaves stale-but-discoverable state. Fired once per failed step.
  TUNNEL_TEARDOWN_PARTIAL_FAILURE: 'tunnel.teardown_partial_failure',
  TEMPLATE_LOOKUP: 'template.lookup',
  PROJECT_LOOKUP: 'project.lookup',
  // services/caddy/portLock.ts — maxHoldMs is an OBSERVABILITY-ONLY watchdog
  // (see docs/local-tunnel-multiplexer-architecture-2026-07-31.md §2.4/§4):
  // it never force-releases the lock, it only surfaces that a generation has
  // been held unusually long.
  PORT_LOCK_MAX_HOLD_EXCEEDED: 'port_lock.max_hold_exceeded',
} as const;
