import { Telemetry, TelemetryEvents, TelemetryProvider, TelemetryEvent } from '../../utils/telemetry.js';

class SpyProvider implements TelemetryProvider {
  captured: TelemetryEvent[] = [];
  identified: Array<{ distinctId: string; properties?: Record<string, any> }> = [];
  flushed = 0;
  shutdown_called = 0;

  capture(event: TelemetryEvent): void {
    this.captured.push(event);
  }
  identify(distinctId: string, properties?: Record<string, any>): void {
    this.identified.push({ distinctId, properties });
  }
  async flush(): Promise<void> {
    this.flushed++;
  }
  async shutdown(): Promise<void> {
    this.shutdown_called++;
  }
}

describe('Telemetry', () => {
  let spy: SpyProvider;

  beforeEach(() => {
    spy = new SpyProvider();
    Telemetry.configure(spy);
    Telemetry.setDistinctId('test-api-key-1234');
  });

  it('forwards capture to the configured provider', () => {
    Telemetry.capture(TelemetryEvents.TOOL_EXECUTED, { toolName: 'check_app', durationMs: 500, success: true });

    expect(spy.captured).toHaveLength(1);
    expect(spy.captured[0].event).toBe('tool.executed');
    expect(spy.captured[0].properties).toEqual({ toolName: 'check_app', durationMs: 500, success: true });
  });

  it('uses hashed distinctId, not the raw key', () => {
    Telemetry.capture('test.event');

    expect(spy.captured[0].distinctId).not.toBe('test-api-key-1234');
    expect(spy.captured[0].distinctId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces a stable distinctId for the same key', () => {
    Telemetry.setDistinctId('stable-key');
    Telemetry.capture('a');
    Telemetry.setDistinctId('stable-key');
    Telemetry.capture('b');

    expect(spy.captured[0].distinctId).toBe(spy.captured[1].distinctId);
  });

  it('produces different distinctIds for different keys', () => {
    Telemetry.setDistinctId('key-a');
    Telemetry.capture('a');
    Telemetry.setDistinctId('key-b');
    Telemetry.capture('b');

    expect(spy.captured[0].distinctId).not.toBe(spy.captured[1].distinctId);
  });

  it('attaches a timestamp to every event', () => {
    Telemetry.capture('ts.test');
    expect(spy.captured[0].timestamp).toBeInstanceOf(Date);
  });

  it('swallows provider errors without crashing', () => {
    const broken: TelemetryProvider = {
      capture() { throw new Error('boom'); },
      identify() { throw new Error('boom'); },
      async flush() { throw new Error('boom'); },
      async shutdown() { throw new Error('boom'); },
    };
    Telemetry.configure(broken);
    expect(() => Telemetry.capture('anything')).not.toThrow();
  });

  it('delegates flush to provider', async () => {
    Telemetry.configure(spy);
    await Telemetry.flush();
    expect(spy.flushed).toBe(1);
  });

  it('delegates shutdown to provider', async () => {
    Telemetry.configure(spy);
    await Telemetry.shutdown();
    expect(spy.shutdown_called).toBe(1);
  });

  it('TelemetryEvents constants are stable', () => {
    expect(TelemetryEvents.TOOL_EXECUTED).toBe('tool.executed');
    expect(TelemetryEvents.TOOL_FAILED).toBe('tool.failed');
    expect(TelemetryEvents.WORKFLOW_EXECUTED).toBe('workflow.executed');
    expect(TelemetryEvents.TUNNEL_PROVISIONED).toBe('tunnel.provisioned');
    expect(TelemetryEvents.TUNNEL_STOPPED).toBe('tunnel.stopped');
  });
});
