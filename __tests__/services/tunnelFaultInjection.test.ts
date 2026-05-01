/**
 * Unit tests for the fault-injection + trace harness (bead 42g).
 *
 * These tests exercise the pure-function parsers and the FaultInjector /
 * TunnelTrace classes. Integration with tunnelManager.createTunnel is covered
 * by tunnelManager.test.ts (bead-42g describe block there).
 */

import { describe, test, expect } from '@jest/globals';
import {
  parseFaultMode,
  getFaultModeFromEnv,
  FaultInjector,
  TunnelTrace,
} from '../../services/ngrok/tunnelFaultInjection.js';

describe('parseFaultMode', () => {
  test('empty / undefined → null', () => {
    expect(parseFaultMode(undefined)).toBeNull();
    expect(parseFaultMode('')).toBeNull();
  });

  test('single mode: fail-connect-N', () => {
    expect(parseFaultMode('fail-connect-N:3')).toEqual({ failConnectN: 3 });
  });

  test('single mode: delay-connect', () => {
    expect(parseFaultMode('delay-connect:500')).toEqual({ delayConnectMs: 500 });
  });

  test('single mode: empty-url-N', () => {
    expect(parseFaultMode('empty-url-N:2')).toEqual({ emptyUrlN: 2 });
  });

  test('multiple comma-separated modes combine', () => {
    const mode = parseFaultMode('fail-connect-N:2,delay-connect:100');
    expect(mode).toEqual({ failConnectN: 2, delayConnectMs: 100 });
  });

  test('unknown token is ignored but valid tokens still parse', () => {
    expect(parseFaultMode('fail-connect-N:1,garbage,delay-connect:50')).toEqual({
      failConnectN: 1,
      delayConnectMs: 50,
    });
  });

  test('malformed value → the token is dropped', () => {
    expect(parseFaultMode('fail-connect-N:abc')).toBeNull();
    expect(parseFaultMode('fail-connect-N')).toBeNull();
  });

  test('zero is a valid count', () => {
    expect(parseFaultMode('fail-connect-N:0')).toEqual({ failConnectN: 0 });
  });
});

describe('getFaultModeFromEnv', () => {
  const originalEnv = process.env.DEBUGG_TUNNEL_FAULT_MODE;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DEBUGG_TUNNEL_FAULT_MODE;
    else process.env.DEBUGG_TUNNEL_FAULT_MODE = originalEnv;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  test('returns null when env var unset', () => {
    delete process.env.DEBUGG_TUNNEL_FAULT_MODE;
    expect(getFaultModeFromEnv()).toBeNull();
  });

  test('returns parsed mode when env var set (dev)', () => {
    process.env.NODE_ENV = 'development';
    process.env.DEBUGG_TUNNEL_FAULT_MODE = 'fail-connect-N:2';
    expect(getFaultModeFromEnv()).toEqual({ failConnectN: 2 });
  });

  test('SAFETY: returns null in production even if env var set', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEBUGG_TUNNEL_FAULT_MODE = 'fail-connect-N:99';
    expect(getFaultModeFromEnv()).toBeNull();
  });
});

describe('FaultInjector', () => {
  test('null mode: no faults', () => {
    const f = new FaultInjector(null);
    expect(f.shouldFailConnect()).toBe(false);
    expect(f.shouldFailConnect()).toBe(false);
    expect(f.shouldReturnEmptyUrl()).toBe(false);
    expect(f.delayMsForAttempt()).toBe(0);
  });

  test('fail-connect-N consumes the counter', () => {
    const f = new FaultInjector({ failConnectN: 2 });
    expect(f.shouldFailConnect()).toBe(true);
    expect(f.shouldFailConnect()).toBe(true);
    expect(f.shouldFailConnect()).toBe(false); // counter exhausted
    expect(f.shouldFailConnect()).toBe(false);
  });

  test('empty-url-N consumes the counter independently of fail-connect-N', () => {
    const f = new FaultInjector({ failConnectN: 1, emptyUrlN: 2 });
    expect(f.shouldFailConnect()).toBe(true);
    expect(f.shouldFailConnect()).toBe(false);
    expect(f.shouldReturnEmptyUrl()).toBe(true);
    expect(f.shouldReturnEmptyUrl()).toBe(true);
    expect(f.shouldReturnEmptyUrl()).toBe(false);
  });

  test('delay persists across attempts (not consumed)', () => {
    const f = new FaultInjector({ delayConnectMs: 250 });
    expect(f.delayMsForAttempt()).toBe(250);
    expect(f.delayMsForAttempt()).toBe(250);
    expect(f.delayMsForAttempt()).toBe(250);
  });

  test('snapshot reflects remaining budget', () => {
    const f = new FaultInjector({ failConnectN: 3, emptyUrlN: 1, delayConnectMs: 10 });
    expect(f.snapshot()).toEqual({ failConnectRemaining: 3, emptyUrlRemaining: 1, delayMs: 10 });
    f.shouldFailConnect();
    expect(f.snapshot().failConnectRemaining).toBe(2);
  });
});

describe('TunnelTrace', () => {
  test('records events with monotonic elapsed time', async () => {
    const t = new TunnelTrace();
    t.emit('start');
    await new Promise((r) => setTimeout(r, 10));
    t.emit('middle', { key: 'value' });
    await new Promise((r) => setTimeout(r, 10));
    t.emit('end');

    const { events, durationMs } = t.toJSON();
    expect(events).toHaveLength(3);
    expect(events[0].event).toBe('start');
    expect(events[1].event).toBe('middle');
    expect(events[1].context).toEqual({ key: 'value' });
    expect(events[2].event).toBe('end');

    expect(events[0].elapsedMs).toBeLessThanOrEqual(events[1].elapsedMs);
    expect(events[1].elapsedMs).toBeLessThanOrEqual(events[2].elapsedMs);
    expect(durationMs).toBeGreaterThanOrEqual(20);
  });

  test('format produces one line per event with padding', () => {
    const t = new TunnelTrace(Date.now() - 100); // synthetic elapsed
    t.emit('a.b');
    t.emit('c.d', { port: 3000 });
    const formatted = t.format();
    expect(formatted).toContain('a.b');
    expect(formatted).toContain('c.d {"port":3000}');
    expect(formatted.split('\n')).toHaveLength(2);
  });

  test('empty trace: durationMs is 0', () => {
    expect(new TunnelTrace().toJSON()).toEqual({
      startTime: expect.any(Number),
      durationMs: 0,
      events: [],
    });
  });
});
