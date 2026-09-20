/**
 * Session — liveness, GOAWAY, probes and socket loss.
 * Bead debugg_ai_mcp-xkoh.1.3 (2.1). Spec: bead debugg_ai_mcp-xkoh.1.2 §7/§8/§9.
 */

import { jest } from '@jest/globals';
import { once } from 'node:events';
import { TunnelSession } from '../../../../services/tunnel/protocol/session.js';
import type { TunnelStream } from '../../../../services/tunnel/protocol/stream.js';
import type { ProbeResult } from '../../../../services/tunnel/protocol/codec.js';
import { SessionClosedError, StreamResetError } from '../../../../services/tunnel/protocol/errors.js';
import {
  CloseCode,
  DEAD_PEER_TIMEOUT_MS,
  ErrorCode,
  PING_INTERVAL_MS,
} from '../../../../services/tunnel/protocol/constants.js';
import { FakeTransport, RawType, raw, waitFor } from './helpers.js';

const sessions: TunnelSession[] = [];

function clientSession(
  transport = new FakeTransport(),
  options: Record<string, unknown> = {},
): { session: TunnelSession; transport: FakeTransport } {
  const session = new TunnelSession(transport, { role: 'client', ...options });
  sessions.push(session);
  return { session, transport };
}

function serverSession(
  transport = new FakeTransport(),
  options: Record<string, unknown> = {},
): { session: TunnelSession; transport: FakeTransport } {
  const session = new TunnelSession(transport, { role: 'server', ...options });
  sessions.push(session);
  return { session, transport };
}

/** Let queued microtasks and setImmediate callbacks run; safe under fake timers. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  while (sessions.length > 0) {
    const session = sessions.pop();
    try {
      session?.close();
    } catch {
      /* stub or already closed */
    }
  }
});

describe('liveness', () => {
  beforeEach(() => {
    // setImmediate stays real so the transports still deliver frames.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('answers a PING with a PONG carrying the same nonce', async () => {
    const { transport } = clientSession();

    transport.deliver(raw.ping(0x0102030405060708n));
    await flush();

    const pongs = transport.framesOfType(RawType.PONG);
    expect(pongs).toHaveLength(1);
    expect(pongs[0].nonce).toBe(0x0102030405060708n);
  });

  it('pings on its own cadence, under the ALB idle timeout', async () => {
    const { transport } = clientSession();

    jest.advanceTimersByTime(PING_INTERVAL_MS);
    await flush();
    expect(transport.framesOfType(RawType.PING)).toHaveLength(1);

    jest.advanceTimersByTime(PING_INTERVAL_MS);
    await flush();
    expect(transport.framesOfType(RawType.PING)).toHaveLength(2);
    expect(PING_INTERVAL_MS).toBeLessThan(60_000);
  });

  it('measures the round trip', async () => {
    const { session, transport } = clientSession();

    const rttPromise = session.ping();
    await flush();
    const ping = transport.framesOfType(RawType.PING)[0];

    jest.advanceTimersByTime(30);
    transport.deliver(raw.pong(ping.nonce!));

    await expect(rttPromise).resolves.toBe(30);
  });

  it('ignores a PONG for a nonce it never sent', async () => {
    const { transport } = clientSession();

    transport.deliver(raw.pong(999n));
    await flush();

    expect(transport.closedWith).toBeUndefined();
  });

  it('declares a silent peer dead and fails its streams', async () => {
    const { session, transport } = clientSession();
    const streamPromise = once(session, 'stream');
    transport.deliver(raw.open(1, { kind: 'http' }));
    const [stream] = (await streamPromise) as [TunnelStream];
    const streamError = once(stream, 'error');
    const closed = once(session, 'close');

    jest.advanceTimersByTime(DEAD_PEER_TIMEOUT_MS);
    await flush();

    const [err] = (await streamError) as [SessionClosedError];
    expect(err).toBeInstanceOf(SessionClosedError);
    expect(err.closeCode).toBe(CloseCode.TIMEOUT);
    const [info] = (await closed) as [{ closeCode: number }];
    expect(info.closeCode).toBe(CloseCode.TIMEOUT);
    // A dead peer cannot complete a close handshake.
    expect(transport.terminated).toBe(true);
  });

  it('treats any inbound frame as proof of life', async () => {
    const { transport } = clientSession();

    jest.advanceTimersByTime(DEAD_PEER_TIMEOUT_MS - 1000);
    await flush();
    expect(transport.terminated).toBe(false);

    transport.deliver(raw.ping(7n));
    await flush();

    jest.advanceTimersByTime(DEAD_PEER_TIMEOUT_MS - 1000);
    await flush();
    expect(transport.terminated).toBe(false);

    jest.advanceTimersByTime(2000);
    await flush();
    expect(transport.terminated).toBe(true);
  });
});

describe('GOAWAY', () => {
  it('stops new streams, drains the open ones, then closes cleanly', async () => {
    const { session, transport } = serverSession();
    const stream = session.openStream();

    const done = session.goAway({ reason: 'deploy' });
    await waitFor(() => transport.framesOfType(RawType.GOAWAY).length === 1, { label: 'GOAWAY sent' });
    expect(transport.framesOfType(RawType.GOAWAY)[0]).toMatchObject({
      code: ErrorCode.GOING_AWAY,
      reason: 'deploy',
    });

    expect(() => session.openStream()).toThrow(StreamResetError);
    expect(transport.closedWith).toBeUndefined();

    // The in-flight stream finishes normally, and only then does the socket go.
    stream.end(Buffer.from('last response'));
    transport.deliver(raw.end(stream.id));

    await done;
    expect(transport.closedWith?.code).toBe(CloseCode.NORMAL);
  });

  it('reports a peer GOAWAY without disturbing the streams already running', async () => {
    const { session, transport } = clientSession();
    const streamPromise = once(session, 'stream');
    transport.deliver(raw.open(1, { kind: 'http' }));
    const [stream] = (await streamPromise) as [TunnelStream];
    const goawayPromise = once(session, 'goaway');

    transport.deliver(raw.goaway(ErrorCode.GOING_AWAY, 'deploy'));

    const [info] = (await goawayPromise) as [{ code: number; reason: string }];
    expect(info).toEqual({ code: ErrorCode.GOING_AWAY, reason: 'deploy' });

    const dataPromise = once(stream, 'data');
    transport.deliver(raw.data(1, 'still serving'));
    const [chunk] = (await dataPromise) as [Buffer];
    expect(chunk.toString('utf8')).toBe('still serving');
    expect(transport.closedWith).toBeUndefined();
  });

  it('tells the client not to come back when the tunnel was revoked', async () => {
    const { session, transport } = clientSession();
    const goawayPromise = once(session, 'goaway');

    transport.deliver(raw.goaway(ErrorCode.REVOKED, 'revoked'));

    const [info] = (await goawayPromise) as [{ code: number }];
    expect(info.code).toBe(ErrorCode.REVOKED);
  });

  it('refuses inbound OPENs once it has sent its own GOAWAY', async () => {
    const { session, transport } = clientSession();
    const streams: TunnelStream[] = [];
    session.on('stream', (stream: TunnelStream) => streams.push(stream));

    void session.goAway();
    await waitFor(() => transport.framesOfType(RawType.GOAWAY).length === 1, { label: 'GOAWAY sent' });

    transport.deliver(raw.open(1, { kind: 'http' }));
    await waitFor(() => transport.framesOfType(RawType.RST).length === 1, { label: 'OPEN refused' });

    expect(transport.framesOfType(RawType.RST)[0]).toMatchObject({ streamId: 1, code: ErrorCode.REFUSED });
    expect(streams).toHaveLength(0);
  });

  it('resets whatever is still open when the drain deadline passes', async () => {
    const { session, transport } = serverSession();
    const stream = session.openStream();
    stream.on('error', () => undefined);

    const done = session.goAway({ drainTimeoutMs: 50 });
    const streamError = once(stream, 'error');

    const [err] = (await streamError) as [StreamResetError];
    expect(err.code).toBe(ErrorCode.GOING_AWAY);
    await done;
    expect(transport.framesOfType(RawType.RST)[0]).toMatchObject({ code: ErrorCode.GOING_AWAY });
    expect(transport.closedWith?.code).toBe(CloseCode.GOING_AWAY);
  });
});

describe('PROBE', () => {
  it('asks over the control channel and resolves with what comes back', async () => {
    const { session, transport } = clientSession();

    const probePromise = session.probe('/health');
    await waitFor(() => transport.framesOfType(RawType.PROBE).length === 1, { label: 'PROBE sent' });
    const probe = transport.framesOfType(RawType.PROBE)[0];
    expect(probe.json).toEqual({ path: '/health' });
    expect(probe.streamId).toBeGreaterThan(0);

    transport.deliver(raw.probeResult(probe.streamId, { status: 200, elapsedMs: 12 }));

    await expect(probePromise).resolves.toEqual({ status: 200, elapsedMs: 12 });
  });

  it('matches concurrent probes by id, in whatever order they are answered', async () => {
    const { session, transport } = clientSession();

    const first = session.probe('/one');
    const second = session.probe('/two');
    await waitFor(() => transport.framesOfType(RawType.PROBE).length === 2, { label: 'both probes sent' });
    const [a, b] = transport.framesOfType(RawType.PROBE);
    expect(a.streamId).not.toBe(b.streamId);

    transport.deliver(raw.probeResult(b.streamId, { status: 204, elapsedMs: 2 }));
    transport.deliver(raw.probeResult(a.streamId, { status: 200, elapsedMs: 9 }));

    await expect(first).resolves.toEqual({ status: 200, elapsedMs: 9 });
    await expect(second).resolves.toEqual({ status: 204, elapsedMs: 2 });
  });

  it('answers TIMEOUT rather than hanging, and ignores a late reply', async () => {
    const { session, transport } = clientSession();

    const result = await session.probe('/slow', { timeoutMs: 20 });
    expect(result.error).toBe('TIMEOUT');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(20);

    const probe = transport.framesOfType(RawType.PROBE)[0];
    transport.deliver(raw.probeResult(probe.streamId, { status: 200, elapsedMs: 900 }));
    expect(transport.closedWith).toBeUndefined();
  });

  it('answers a probe on the server side with the handler result', async () => {
    const onProbe = async (): Promise<ProbeResult> => ({ status: 200, elapsedMs: 5 });
    const { transport } = serverSession(new FakeTransport(), { onProbe });

    transport.deliver(raw.probe(7, '/health'));
    await waitFor(() => transport.framesOfType(RawType.PROBE_RESULT).length === 1, { label: 'answered' });

    const answer = transport.framesOfType(RawType.PROBE_RESULT)[0];
    expect(answer.streamId).toBe(7);
    expect(answer.json).toEqual({ status: 200, elapsedMs: 5 });
  });

  it('turns a failing probe handler into an error result, not a dead session', async () => {
    const onProbe = async (): Promise<ProbeResult> => {
      throw new Error('boom');
    };
    const { session, transport } = serverSession(new FakeTransport(), { onProbe });

    transport.deliver(raw.probe(7, '/health'));
    await waitFor(() => transport.framesOfType(RawType.PROBE_RESULT).length === 1, { label: 'answered' });

    expect(transport.framesOfType(RawType.PROBE_RESULT)[0].json).toMatchObject({ error: 'PROBE_FAILED' });
    expect(session.closed).toBe(false);
  });
});

describe('losing the socket', () => {
  it('fails every open stream and settles every pending call', async () => {
    const { session, transport } = clientSession();
    const streams: TunnelStream[] = [];
    session.on('stream', (stream: TunnelStream) => {
      stream.on('error', () => undefined);
      streams.push(stream);
    });
    transport.deliver(raw.open(1, { kind: 'http' }), raw.open(2, { kind: 'http' }));
    await waitFor(() => streams.length === 2, { label: 'streams open' });

    const probePromise = session.probe('/health', { timeoutMs: 10_000 });
    const pingPromise = session.ping().catch((err: unknown) => err);
    const errors = streams.map((stream) => once(stream, 'error'));
    const closed = once(session, 'close');

    transport.deliverClose(1006, 'socket hung up');

    for (const errorPromise of errors) {
      const [err] = (await errorPromise) as [SessionClosedError];
      expect(err).toBeInstanceOf(SessionClosedError);
      expect(err.closeCode).toBe(1006);
    }
    await expect(probePromise).resolves.toMatchObject({ error: 'CLOSED' });
    await expect(pingPromise).resolves.toBeInstanceOf(SessionClosedError);
    const [info] = (await closed) as [{ closeCode: number; remote: boolean }];
    expect(info).toMatchObject({ closeCode: 1006, remote: true });
    expect(session.activeStreamCount).toBe(0);
  });
});
