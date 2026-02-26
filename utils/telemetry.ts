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
  TUNNEL_PROVISIONED: 'tunnel.provisioned',
  TUNNEL_STOPPED: 'tunnel.stopped',
} as const;
